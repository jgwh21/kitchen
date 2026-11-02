// Kitchen files: what you send a friend (or keep as a backup), and reading them back in.
//
// A .kitchen file is JSON:
//   { format: 'kitchen-inventory', version: 1, kind: 'share' | 'backup',
//     kitchenId, name, owner, exportedAt, items: [{ ...item, thumb, photo? }], settings?, tally? }
// thumb/photo are base64 JPEG. 'share' files carry thumbnails only, so they stay small enough
// for WhatsApp or email; 'backup' files also carry the full label photos and your settings.
// The Claude API key is never included in either.

import * as db from './db.js';
import { blobToBase64, base64ToBlob } from './images.js';

const FORMAT = 'kitchen-inventory';

export async function buildKitchenFile(kind, settings, tally) {
  const items = await db.getAll('items');
  const out = [];
  for (const item of items) {
    const thumb = await db.get('thumbs', item.id);
    const photo = kind === 'backup' ? await db.get('photos', item.id) : null;
    out.push({
      ...item,
      thumb: thumb ? await blobToBase64(thumb) : '',
      ...(photo ? { photo: await blobToBase64(photo) } : {}),
    });
  }
  const file = {
    format: FORMAT,
    version: 1,
    kind,
    kitchenId: settings.kitchenId,
    name: settings.kitchenName,
    owner: settings.owner,
    exportedAt: new Date().toISOString(),
    items: out,
    ...(kind === 'backup' ? { settings: { ...settings }, tally } : {}),
  };
  return new Blob([JSON.stringify(file)], { type: 'application/json' });
}

export class NotAKitchenFile extends Error {}

export async function readKitchenFile(blob) {
  let data;
  try {
    data = JSON.parse(await blob.text());
  } catch {
    throw new NotAKitchenFile('That file isn\'t a kitchen file.');
  }
  if (data?.format !== FORMAT || !Array.isArray(data.items) || !data.kitchenId) {
    throw new NotAKitchenFile('That file isn\'t a kitchen file.');
  }
  if (data.version > 1) throw new NotAKitchenFile('That file was made by a newer version of the app. Update this app first (Settings → Check for updates).');
  return data;
}

const strip = ({ thumb, photo, ...item }) => item;

/** Merges items from one of your own files: an item newer in the file replaces yours. */
export async function mergeIntoMine(data) {
  const mine = new Map((await db.getAll('items')).map((i) => [i.id, i]));
  const ops = [];
  let added = 0;
  let updated = 0;
  for (const item of data.items) {
    const have = mine.get(item.id);
    if (have && (have.updated || '') >= (item.updated || '')) continue;
    have ? updated++ : added++;
    ops.push({ store: 'items', value: strip(item) });
    if (item.thumb) ops.push({ store: 'thumbs', key: item.id, value: base64ToBlob(item.thumb) });
    if (item.photo) ops.push({ store: 'photos', key: item.id, value: base64ToBlob(item.photo) });
  }
  await db.putMany(ops);
  return { added, updated };
}

/** Replaces this kitchen with the file's contents (moving to a new phone). */
export async function replaceMine(data) {
  const ops = (await db.getAll('items')).flatMap((i) => [
    { store: 'items', key: i.id }, { store: 'thumbs', key: i.id }, { store: 'photos', key: i.id },
  ]);
  await db.putMany(ops);
  return mergeIntoMine(data);
}

/** Saves a friend's kitchen to view. Returns false if you already have a newer copy. */
export async function saveFriend(data) {
  const have = await db.get('friends', data.kitchenId);
  if (have && have.exportedAt > data.exportedAt) return false;
  await db.set('friends', null, {
    id: data.kitchenId,
    name: data.name || 'Shared kitchen',
    owner: data.owner || '',
    exportedAt: data.exportedAt,
    items: data.items.map(({ photo, ...item }) => item), // keep thumbnails, drop full photos
  });
  return true;
}

// ---------- spreadsheet and message exports ----------

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(items) {
  const cols = [
    ['Name', 'name'], ['Brand', 'brand'], ['Type', 'type'], ['Location', 'location'],
    ['Quantity', 'quantity'], ['Unit', 'unit'], ['Left %', 'left'], ['Expiry', 'expiry'],
    ['Expiry kind', (i) => ({ use_by: 'Use by', best_before: 'Best before' })[i.expiryKind] || ''],
    ['Opened', 'opened'], ['Notes', 'notes'], ['Added', (i) => (i.added ? new Date(i.added).toLocaleDateString('en-CA') : '')],
  ];
  const rows = [cols.map(([h]) => h)];
  for (const i of items) rows.push(cols.map(([, f]) => (typeof f === 'function' ? f(i) : i[f])));
  // A byte-order mark so Excel reads £, é etc. correctly.
  return `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export function toText(title, items, describeExpiry) {
  const byLoc = new Map();
  for (const i of items) {
    const k = i.location || 'Other';
    if (!byLoc.has(k)) byLoc.set(k, []);
    byLoc.get(k).push(i);
  }
  const lines = [title, ''];
  for (const [loc, list] of [...byLoc].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`${loc}:`);
    for (const i of list.sort((a, b) => a.name.localeCompare(b.name))) {
      const bits = [i.quantity && `${i.quantity}${i.unit ? ` ${i.unit}` : ''}`,
        i.left < 100 && `${i.left}% left`, describeExpiry(i)].filter(Boolean);
      lines.push(`• ${i.name}${bits.length ? ` (${bits.join(', ')})` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}
