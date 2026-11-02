import * as db from './db.js';
import { preparePhoto, blobToBase64, base64ToBlob } from './images.js';
import { readLabel, AiError, MODELS, DEFAULT_MODEL } from './ai.js';
import {
  buildKitchenFile, readKitchenFile, mergeIntoMine, replaceMine, saveFriend, toCsv, toText, NotAKitchenFile,
} from './share.js';

// Must equal VERSION in sw.js and the app-version meta tag in index.html;
// `python build-upload.py --bump` updates all three, and the build refuses if they differ.
const APP_VERSION = 'kitchen-v1';

const $ = (id) => document.getElementById(id);
const DAY = 86_400_000;

const DEFAULT_LOCATIONS = [
  'Fridge – top shelf', 'Fridge – middle shelf', 'Fridge – bottom shelf', 'Fridge – salad drawer', 'Fridge – door',
  'Freezer – drawer 1', 'Freezer – drawer 2', 'Freezer – drawer 3', 'Cupboard', 'Counter',
];
const DEFAULT_TYPES = [
  'Fresh produce', 'Meat & fish', 'Dairy & eggs', 'Frozen', 'Leftovers & ready meals', 'Bakery',
  'Drinks', 'Sauces & condiments', 'Tins & jars', 'Dry goods', 'Snacks', 'Other',
];

const state = {
  settings: null,
  apiKey: '',
  tally: { used: 0, binned: 0 },
  items: [],            // this kitchen's items
  friends: [],          // kitchens shared with you
  view: 'mine',         // 'mine' or a friend's kitchenId
  thumbUrls: new Map(), // `${kitchen}:${id}` -> object URL
  sort: 'name',
  query: '',
  filterLocation: '',
  filterType: '',
  draft: null,          // item being added/edited: { item, isNew, photo, thumb, touched, aiToken }
};

// ---------- small helpers ----------

const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const versionNumber = () => APP_VERSION.replace('kitchen-v', '');

function localDate(d = new Date()) {
  return new Date(d - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

/** Whole days from today to a YYYY-MM-DD date (negative = past), or null. */
function daysUntil(date) {
  if (!date) return null;
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date();
  return Math.round((new Date(y, m - 1, d) - new Date(t.getFullYear(), t.getMonth(), t.getDate())) / DAY);
}

function fmtDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(y !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
}

/** { level: 'expired'|'soon'|'ok'|'none', text } describing an item's expiry. */
function expiryInfo(item) {
  const n = daysUntil(item.expiry);
  if (n === null) return { level: 'none', text: '' };
  const bb = item.expiryKind === 'best_before';
  if (n < 0) {
    const ago = n === -1 ? 'yesterday' : `${-n} days ago`;
    return { level: bb ? 'soon' : 'expired', text: bb ? `Best before ${ago}` : `Expired ${ago}` };
  }
  const word = bb ? 'Best before' : 'Use by';
  if (n === 0) return { level: 'soon', text: `${word} today` };
  if (n === 1) return { level: 'soon', text: `${word} tomorrow` };
  if (n <= state.settings.soonDays) return { level: 'soon', text: `${word} in ${n} days` };
  return { level: 'ok', text: `${word} ${fmtDate(item.expiry)}` };
}

let toastTimer;
function toast(msg, ms = 3500, action = null) {
  const t = $('toast');
  $('toast-text').textContent = msg;
  const btn = $('toast-action');
  btn.hidden = !action;
  btn.onclick = null;
  if (action) {
    btn.textContent = action.label;
    btn.onclick = () => { t.hidden = true; action.run(); };
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

/** Shows a question with buttons; resolves with the chosen option's value (null if dismissed). */
function choose(title, text, options) {
  const dlg = $('chooser');
  $('chooser-title').textContent = title;
  $('chooser-text').textContent = text;
  const box = $('chooser-options');
  box.replaceChildren();
  return new Promise((resolve) => {
    for (const o of options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn block ${o.style || ''}`;
      b.textContent = o.label;
      b.onclick = () => { dlg.close(); resolve(o.value); };
      box.append(b);
    }
    dlg.oncancel = () => resolve(null);
    dlg.showModal();
  });
}

function openSheet(dlg) {
  dlg.showModal();
  dlg.querySelector('.sheet-body')?.scrollTo(0, 0);
}

for (const dlg of document.querySelectorAll('dialog.sheet')) {
  dlg.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) dlg.close();
  });
}

/** Saves a file through the share sheet where available (iPhone/Android), otherwise downloads it. */
async function deliverFile(blob, name, title) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return true;
    } catch (err) {
      if (err.name === 'AbortError') return false;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  return true;
}

const fileSafe = (s) => s.replace(/[\\/:*?"<>|]+/g, '').trim() || 'Kitchen';

// ---------- data ----------

async function loadSettings() {
  const saved = await db.get('meta', 'settings');
  state.settings = {
    kitchenId: randomId(),
    owner: '',
    kitchenName: '',
    locations: DEFAULT_LOCATIONS,
    types: DEFAULT_TYPES,
    autoRead: true,
    model: DEFAULT_MODEL,
    soonDays: 3,
    lastLocation: '',
    ...saved,
  };
  if (!saved) await saveSettings();
  if (!MODELS[state.settings.model]) state.settings.model = DEFAULT_MODEL;
  state.apiKey = (await db.get('meta', 'apiKey')) || '';
  state.tally = (await db.get('meta', 'tally')) || state.tally;
}

const saveSettings = () => db.set('meta', 'settings', state.settings);

function kitchenTitle() {
  const s = state.settings;
  return s.kitchenName || (s.owner ? `${s.owner}'s Kitchen Inventory` : 'Kitchen Inventory');
}

async function loadData() {
  state.items = await db.getAll('items');
  state.friends = (await db.getAll('friends')).sort((a, b) => a.name.localeCompare(b.name));
  if (state.view !== 'mine' && !state.friends.some((f) => f.id === state.view)) state.view = 'mine';
}

function viewed() {
  if (state.view === 'mine') return { mine: true, name: kitchenTitle(), items: state.items };
  const f = state.friends.find((k) => k.id === state.view);
  return { mine: false, name: f.name, owner: f.owner, exportedAt: f.exportedAt, items: f.items, friend: f };
}

async function thumbUrl(item) {
  const key = `${state.view}:${item.id}`;
  if (state.thumbUrls.has(key)) return state.thumbUrls.get(key);
  let blob = null;
  if (state.view === 'mine') blob = await db.get('thumbs', item.id);
  else if (item.thumb) blob = base64ToBlob(item.thumb);
  const url = blob ? URL.createObjectURL(blob) : '';
  state.thumbUrls.set(key, url);
  return url;
}

function forgetThumb(id) {
  const key = `mine:${id}`;
  const url = state.thumbUrls.get(key);
  if (url) URL.revokeObjectURL(url);
  state.thumbUrls.delete(key);
}

// ---------- list ----------

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

function sorted(items) {
  const byName = (a, b) => collator.compare(a.name, b.name);
  const fns = {
    name: byName,
    expiry: (a, b) => (a.expiry || '9999').localeCompare(b.expiry || '9999') || byName(a, b),
    location: (a, b) => locRank(a.location) - locRank(b.location) || collator.compare(a.location, b.location) || byName(a, b),
    type: (a, b) => typeRank(a.type) - typeRank(b.type) || collator.compare(a.type, b.type) || byName(a, b),
    left: (a, b) => a.left - b.left || byName(a, b),
    added: (a, b) => (b.added || '').localeCompare(a.added || ''),
  };
  return [...items].sort(fns[state.sort]);
}
const rank = (list, v) => { const i = list.indexOf(v); return i < 0 ? list.length : i; };
const locRank = (v) => rank(state.settings.locations, v);
const typeRank = (v) => rank(state.settings.types, v);

function groupOf(item) {
  if (state.sort === 'location') return item.location || 'No location';
  if (state.sort === 'type') return item.type || 'No type';
  if (state.sort === 'expiry') {
    const { level } = expiryInfo(item);
    return { expired: 'Expired', soon: 'Use soon', ok: 'Later', none: 'No date' }[level];
  }
  return null;
}

function matches(item) {
  if (state.filterLocation && item.location !== state.filterLocation) return false;
  if (state.filterType && item.type !== state.filterType) return false;
  if (!state.query) return true;
  const q = state.query.toLowerCase();
  return [item.name, item.brand, item.notes, item.type, item.location].some((v) => v?.toLowerCase().includes(q));
}

function fillFilter(select, label, values, current) {
  const opts = [`<option value="">${label}</option>`, ...values.map((v) => `<option${v === current ? ' selected' : ''}>${esc(v)}</option>`)];
  select.innerHTML = opts.join('');
}

let renderToken = 0;
async function render() {
  const token = ++renderToken;
  const k = viewed();
  document.title = k.name;
  $('kitchen-title').textContent = k.name;
  $('kitchen-caret').hidden = !state.friends.length;
  $('fab-row').hidden = !k.mine;
  $('friend-note').hidden = k.mine;
  if (!k.mine) {
    $('friend-note').textContent = `Shared by ${k.owner || 'a friend'} on ${new Date(k.exportedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })} · view only`;
  }

  // Filters offer the configured lists plus anything items actually use.
  const used = (field, base) => [...new Set([...base, ...k.items.map((i) => i[field]).filter(Boolean)])];
  const locs = used('location', k.mine ? state.settings.locations : []).filter((l) => k.items.some((i) => i.location === l));
  const types = used('type', k.mine ? state.settings.types : []).filter((t) => k.items.some((i) => i.type === t));
  if (state.filterLocation && !locs.includes(state.filterLocation)) state.filterLocation = '';
  if (state.filterType && !types.includes(state.filterType)) state.filterType = '';
  fillFilter($('filter-location'), 'All locations', locs, state.filterLocation);
  fillFilter($('filter-type'), 'All types', types, state.filterType);

  const expired = k.items.filter((i) => expiryInfo(i).level === 'expired').length;
  const soon = k.items.filter((i) => expiryInfo(i).level === 'soon').length;
  $('summary-line').textContent = `${k.items.length} item${k.items.length === 1 ? '' : 's'}`;
  const banner = $('soon-banner');
  banner.hidden = !(expired || soon);
  banner.className = `soon-banner ${expired ? 'expired' : 'soon'}`;
  banner.textContent = [
    expired && `${expired} expired`, soon && `${soon} to use soon`,
  ].filter(Boolean).join(' · ') + (state.sort === 'expiry' ? '' : ' — tap to see');

  const shown = sorted(k.items.filter(matches));
  const list = $('list');
  const empty = $('empty');
  empty.hidden = shown.length > 0;
  if (!k.items.length) {
    empty.innerHTML = k.mine
      ? '<p><strong>Nothing here yet.</strong></p><p class="muted">Tap <strong>Add item</strong> and photograph the label. Claude can read the name and expiry date for you (set it up in Settings).</p>'
      : '<p class="muted">This kitchen was shared empty.</p>';
  } else if (!shown.length) {
    empty.innerHTML = '<p class="muted">Nothing matches.</p>';
  }

  const parts = [];
  let lastGroup;
  for (const item of shown) {
    const g = groupOf(item);
    if (g !== null && g !== lastGroup) {
      parts.push(`<h3 class="group">${esc(g)}</h3>`);
      lastGroup = g;
    }
    const ex = expiryInfo(item);
    const sub = [item.brand, item.quantity && `${item.quantity}${item.unit ? ` ${item.unit}` : ''}`].filter(Boolean).join(' · ');
    const tags = [
      state.sort !== 'location' && item.location, state.sort !== 'type' && item.type,
    ].filter(Boolean).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
    parts.push(`
      <button class="row" type="button" data-id="${esc(item.id)}">
        <span class="thumb" data-thumb="${esc(item.id)}"></span>
        <span class="row-main">
          <span class="row-name">${esc(item.name)}</span>
          ${sub ? `<span class="row-sub">${esc(sub)}</span>` : ''}
          <span class="row-tags">${tags}${item.opened ? '<span class="tag">Opened</span>' : ''}</span>
        </span>
        <span class="row-side">
          ${ex.text ? `<span class="badge ${ex.level}">${esc(ex.text)}</span>` : ''}
          <span class="meter" title="${item.left}% left"><span style="width:${item.left}%" class="${item.left <= 25 ? 'low' : ''}"></span></span>
        </span>
      </button>`);
  }
  list.innerHTML = parts.join('');

  for (const el of list.querySelectorAll('[data-thumb]')) {
    const item = k.items.find((i) => i.id === el.dataset.thumb);
    const url = await thumbUrl(item);
    if (token !== renderToken) return;
    el.style.backgroundImage = url ? `url("${url}")` : '';
    el.classList.toggle('none', !url);
  }
}

$('list').addEventListener('click', (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  if (state.view === 'mine') openEditor(state.items.find((i) => i.id === row.dataset.id));
  else openViewer(viewed().items.find((i) => i.id === row.dataset.id));
});

$('search').addEventListener('input', (e) => { state.query = e.target.value.trim(); render(); });
$('sort').addEventListener('change', (e) => { state.sort = e.target.value; remember(); render(); });
$('filter-location').addEventListener('change', (e) => { state.filterLocation = e.target.value; render(); });
$('filter-type').addEventListener('change', (e) => { state.filterType = e.target.value; render(); });
$('soon-banner').addEventListener('click', () => {
  state.sort = 'expiry';
  $('sort').value = 'expiry';
  remember();
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

function remember() {
  try { localStorage.setItem('sort', state.sort); } catch { /* private mode */ }
}

// ---------- adding and editing ----------

const FIELDS = ['name', 'brand', 'type', 'location', 'quantity', 'unit', 'left', 'expiry', 'expiryKind', 'opened', 'notes'];
const fieldEl = (f) => $(`f-${f.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);

function fillSelect(select, values, current) {
  const all = current && !values.includes(current) ? [...values, current] : values;
  select.innerHTML = all.map((v) => `<option${v === current ? ' selected' : ''}>${esc(v)}</option>`).join('');
}

function setLeft(v) {
  $('f-left').value = v;
  $('left-out').textContent = `${v}%`;
}

async function openEditor(item, photoFile = null) {
  const isNew = !item;
  item ??= {
    id: randomId(), name: '', brand: '', type: 'Other', location: state.settings.lastLocation || state.settings.locations[0] || '',
    quantity: '', unit: '', left: 100, expiry: '', expiryKind: '', opened: '', notes: '',
  };
  state.draft = { item, isNew, photo: null, thumb: null, touched: new Set(), aiToken: 0 };
  $('editor-title').textContent = isNew ? 'New item' : 'Edit item';
  fillSelect($('f-type'), state.settings.types, item.type);
  fillSelect($('f-location'), state.settings.locations, item.location);
  for (const f of FIELDS) {
    if (f === 'left') continue;
    const el = fieldEl(f);
    el.classList.remove('ai-filled');
    const v = item[f] ?? '';
    if (el.tagName === 'SELECT' && v && ![...el.options].some((o) => o.value === v)) el.append(new Option(v, v));
    el.value = v;
  }
  setLeft(item.left ?? 100);
  $('finish-row').hidden = isNew;
  $('delete-btn').hidden = isNew;
  $('ai-status').hidden = true;
  showPhoto(isNew ? null : await db.get('photos', item.id));
  openSheet($('editor'));
  if (photoFile) await usePhoto(photoFile);
}

function showPhoto(blob) {
  const img = $('photo-preview');
  if (img.src) URL.revokeObjectURL(img.src);
  img.removeAttribute('src');
  img.hidden = !blob;
  $('photo-empty').hidden = !!blob;
  if (blob) img.src = URL.createObjectURL(blob);
  $('retake-btn').textContent = blob ? 'Retake' : 'Take photo';
  $('read-btn').hidden = !blob || !state.apiKey;
}

async function usePhoto(file) {
  const d = state.draft;
  setAiStatus('Preparing photo…', 'working');
  try {
    Object.assign(d, await preparePhoto(file));
  } catch {
    setAiStatus('That photo couldn\'t be opened. Try taking it again.', 'error');
    return;
  }
  showPhoto(d.photo);
  if (state.apiKey && state.settings.autoRead) await readDraftLabel();
  else setAiStatus(state.apiKey ? '' : 'Tip: add a Claude API key in Settings and the details fill in by themselves.', 'hint');
}

function setAiStatus(text, kind = '') {
  const el = $('ai-status');
  el.hidden = !text;
  el.textContent = text;
  el.className = `ai-status ${kind}`;
}

async function readDraftLabel() {
  const d = state.draft;
  const blob = d.photo || (await db.get('photos', d.item.id));
  if (!blob) return;
  const token = ++d.aiToken;
  setAiStatus('Claude is reading the label…', 'working');
  $('read-btn').disabled = true;
  try {
    const out = await readLabel(await blobToBase64(blob), {
      apiKey: state.apiKey, model: state.settings.model, types: state.settings.types,
    });
    if (state.draft !== d || token !== d.aiToken) return; // editor closed or a newer read started
    const fill = {
      name: out.name, brand: out.brand, type: out.type, quantity: out.quantity, unit: out.unit,
      expiry: out.expiry, expiryKind: out.expiry_kind, notes: out.notes,
    };
    let filled = 0;
    for (const [f, v] of Object.entries(fill)) {
      if (!v || d.touched.has(f)) continue; // never overwrite what you typed
      const el = fieldEl(f);
      if (el.tagName === 'SELECT' && ![...el.options].some((o) => o.value === v)) {
        if (f !== 'unit') continue;
        el.append(new Option(v, v));
      }
      el.value = v;
      el.classList.add('ai-filled');
      filled++;
    }
    setAiStatus(filled
      ? `Filled in by Claude${out.expiry ? '' : ' (no date found on the label)'}. Check it's right before saving.`
      : 'Claude found nothing new to fill in.', 'done');
  } catch (err) {
    if (state.draft !== d) return;
    setAiStatus(err instanceof AiError ? err.message : 'Something went wrong reading the label.', 'error');
  } finally {
    $('read-btn').disabled = false;
  }
}

$('item-form').addEventListener('input', (e) => {
  const f = FIELDS.find((x) => fieldEl(x) === e.target);
  if (f && state.draft) {
    state.draft.touched.add(f);
    e.target.classList.remove('ai-filled');
  }
});
$('f-left').addEventListener('input', (e) => setLeft(e.target.value));
for (const b of document.querySelectorAll('[data-left]')) {
  b.addEventListener('click', () => setLeft(b.dataset.left));
}

$('add-btn').addEventListener('click', () => pick($('camera-input')));
$('type-btn').addEventListener('click', () => openEditor(null));
$('retake-btn').addEventListener('click', () => pick($('camera-input')));
$('library-btn').addEventListener('click', () => pick($('library-input')));
$('read-btn').addEventListener('click', readDraftLabel);

function pick(input) {
  input.value = '';
  input.click();
}

for (const id of ['camera-input', 'library-input']) {
  $(id).addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if ($('editor').open) usePhoto(file);
    else openEditor(null, file);
  });
}

$('item-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const d = state.draft;
  const item = { ...d.item };
  for (const f of FIELDS) item[f] = f === 'left' ? Number($('f-left').value) : fieldEl(f).value.trim();
  if (!item.name) {
    $('f-name').focus();
    return toast('Give it a name first.');
  }
  const now = new Date().toISOString();
  item.updated = now;
  if (d.isNew) item.added = now;
  const ops = [{ store: 'items', value: item }];
  if (d.photo) {
    ops.push({ store: 'photos', key: item.id, value: d.photo }, { store: 'thumbs', key: item.id, value: d.thumb });
    forgetThumb(item.id);
  }
  try {
    await db.putMany(ops);
  } catch (err) {
    return toast(`Couldn't save: ${err.message}`, 6000);
  }
  if (item.location !== state.settings.lastLocation) {
    state.settings.lastLocation = item.location;
    saveSettings();
  }
  navigator.storage?.persist?.().catch(() => {});
  state.draft = null;
  $('editor').close();
  await loadData();
  render();
  toast(d.isNew ? `Added ${item.name}` : 'Saved');
});

$('editor').addEventListener('close', () => { state.draft = null; });

async function finishItem(kind) {
  const { item } = state.draft;
  const photo = await db.get('photos', item.id);
  const thumb = await db.get('thumbs', item.id);
  await db.deleteItem(item.id);
  forgetThumb(item.id);
  if (kind) {
    state.tally[kind]++;
    await db.set('meta', 'tally', state.tally);
  }
  $('editor').close();
  await loadData();
  render();
  const msg = { used: `${item.name}: used up`, binned: `${item.name}: thrown away` }[kind] || `Deleted ${item.name}`;
  toast(msg, 6000, {
    label: 'Undo',
    run: async () => {
      await db.putMany([
        { store: 'items', value: item },
        ...(photo ? [{ store: 'photos', key: item.id, value: photo }] : []),
        ...(thumb ? [{ store: 'thumbs', key: item.id, value: thumb }] : []),
      ]);
      if (kind) {
        state.tally[kind]--;
        await db.set('meta', 'tally', state.tally);
      }
      await loadData();
      render();
    },
  });
}
$('used-btn').addEventListener('click', () => finishItem('used'));
$('binned-btn').addEventListener('click', () => finishItem('binned'));
$('delete-btn').addEventListener('click', () => finishItem(null));

// ---------- a friend's item (read-only) ----------

async function openViewer(item) {
  $('viewer-title').textContent = item.name;
  const ex = expiryInfo(item);
  const url = await thumbUrl(item);
  const rows = [
    ['Brand / shop', item.brand], ['Type', item.type], ['Location', item.location],
    ['Quantity', item.quantity && `${item.quantity} ${item.unit || ''}`], ['Left', `${item.left}%`],
    ['Expiry', ex.text], ['Opened', item.opened && fmtDate(item.opened)], ['Notes', item.notes],
  ].filter(([, v]) => v);
  $('viewer-body').innerHTML = `
    ${url ? `<img class="viewer-photo" src="${url}" alt="">` : ''}
    <dl class="facts">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
  openSheet($('viewer'));
}

// ---------- kitchens ----------

function renderKitchens() {
  const rows = [{ id: 'mine', name: kitchenTitle(), sub: `${state.items.length} items · yours` },
    ...state.friends.map((f) => ({
      id: f.id, name: f.name, friend: true,
      sub: `${f.items.length} items · from ${f.owner || 'a friend'}, ${new Date(f.exportedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`,
    }))];
  $('kitchen-list').innerHTML = rows.map((r) => `
    <div class="kitchen-row${r.id === state.view ? ' current' : ''}">
      <button type="button" class="kitchen-pick" data-kitchen="${esc(r.id)}">
        <strong>${esc(r.name)}</strong><span class="muted">${esc(r.sub)}</span>
      </button>
      ${r.friend ? `<button type="button" class="btn ghost danger-text small" data-remove="${esc(r.id)}">Remove</button>` : ''}
    </div>`).join('');
}

$('kitchen-btn').addEventListener('click', () => {
  renderKitchens();
  openSheet($('kitchens'));
});
$('kitchen-list').addEventListener('click', async (e) => {
  const pickBtn = e.target.closest('[data-kitchen]');
  const removeBtn = e.target.closest('[data-remove]');
  if (pickBtn) {
    switchTo(pickBtn.dataset.kitchen);
    $('kitchens').close();
  } else if (removeBtn) {
    const f = state.friends.find((k) => k.id === removeBtn.dataset.remove);
    const ok = await choose(`Remove ${f.name}?`, 'You can add it again if they share it with you again.', [
      { label: 'Remove', value: true, style: 'danger' }, { label: 'Cancel', value: false },
    ]);
    if (!ok) return;
    await db.del('friends', f.id);
    for (const [key, url] of state.thumbUrls) {
      if (key.startsWith(`${f.id}:`)) { URL.revokeObjectURL(url); state.thumbUrls.delete(key); }
    }
    await loadData();
    renderKitchens();
    render();
  }
});

function switchTo(view) {
  state.view = view;
  state.filterLocation = '';
  state.filterType = '';
  render();
  window.scrollTo(0, 0);
}

// ---------- share, export, import ----------

$('share-btn').addEventListener('click', async () => {
  if (!state.settings.owner) {
    $('s-owner').focus();
    return toast('Add your name first, so friends know whose kitchen it is.');
  }
  const blob = await buildKitchenFile('share', state.settings, state.tally);
  await deliverFile(blob, `${fileSafe(kitchenTitle())}.kitchen.json`, kitchenTitle());
});

$('text-btn').addEventListener('click', async () => {
  const k = viewed();
  const text = toText(k.name, k.items, (i) => expiryInfo(i).text);
  try {
    if (navigator.share) await navigator.share({ text });
    else {
      await navigator.clipboard.writeText(text);
      toast('List copied. Paste it into a message.');
    }
  } catch (err) {
    if (err.name !== 'AbortError') toast('Couldn\'t share the list.');
  }
});

$('csv-btn').addEventListener('click', async () => {
  const k = viewed();
  const blob = new Blob([toCsv(sorted(k.items))], { type: 'text/csv' });
  await deliverFile(blob, `${fileSafe(k.name)} ${localDate()}.csv`, k.name);
});

$('backup-btn').addEventListener('click', async () => {
  toast('Preparing backup…');
  const blob = await buildKitchenFile('backup', state.settings, state.tally);
  if (await deliverFile(blob, `${fileSafe(kitchenTitle())} backup ${localDate()}.kitchen.json`, 'Kitchen backup')) {
    await db.set('meta', 'lastBackup', new Date().toISOString());
    renderSettings();
  }
});

$('import-btn').addEventListener('click', () => pick($('import-input')));
$('kitchens-import-btn').addEventListener('click', () => pick($('import-input')));

$('import-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  let data;
  try {
    data = await readKitchenFile(file);
  } catch (err) {
    return toast(err instanceof NotAKitchenFile ? err.message : 'That file couldn\'t be read.', 6000);
  }
  const n = data.items.length;
  if (data.kitchenId === state.settings.kitchenId) {
    const ok = await choose('This is your own kitchen', `The file has ${n} items. Bring back any that are missing or newer in the file?`, [
      { label: 'Bring them back', value: true, style: 'primary' }, { label: 'Cancel', value: false },
    ]);
    if (!ok) return;
    const { added, updated } = await mergeIntoMine(data);
    await afterImport('mine');
    return toast(`${added} added, ${updated} updated.`);
  }
  let action = 'friend';
  if (data.kind === 'backup') {
    action = await choose(`Backup of ${data.name || 'a kitchen'}`, `${n} items. Is this your kitchen (for example, moving to a new phone), or someone else's to look at?`, [
      { label: 'It\'s mine: replace this phone\'s kitchen', value: 'replace', style: 'danger' },
      { label: 'Just view it', value: 'friend', style: 'primary' },
      { label: 'Cancel', value: null },
    ]);
  }
  if (action === 'replace') {
    await replaceMine(data);
    state.settings = { ...state.settings, ...data.settings, kitchenId: data.kitchenId };
    await saveSettings();
    if (data.tally) await db.set('meta', 'tally', (state.tally = data.tally));
    for (const url of state.thumbUrls.values()) if (url) URL.revokeObjectURL(url);
    state.thumbUrls.clear();
    await afterImport('mine');
    toast(`Restored ${n} items.`);
  } else if (action === 'friend') {
    if (!(await saveFriend(data))) return toast('You already have a newer copy of that kitchen.', 5000);
    for (const [key, url] of state.thumbUrls) {
      if (key.startsWith(`${data.kitchenId}:`)) { URL.revokeObjectURL(url); state.thumbUrls.delete(key); }
    }
    await afterImport(data.kitchenId);
    toast(`Showing ${data.name}. Tap the title to switch back to yours.`, 6000);
  }
});

async function afterImport(view) {
  await loadData();
  for (const dlg of document.querySelectorAll('dialog[open]')) dlg.close();
  switchTo(view);
}

// ---------- settings ----------

async function renderSettings() {
  const s = state.settings;
  $('s-owner').value = s.owner;
  $('s-name').value = s.kitchenName;
  $('s-name').placeholder = s.owner ? `${s.owner}'s Kitchen Inventory` : 'e.g. JG\'s Kitchen Inventory';
  $('s-auto-read').checked = s.autoRead;
  $('s-api-key').value = state.apiKey;
  $('s-model').innerHTML = Object.entries(MODELS).map(([id, label]) => `<option value="${id}"${id === s.model ? ' selected' : ''}>${esc(label)}</option>`).join('');
  $('s-locations').value = s.locations.join('\n');
  $('s-types').value = s.types.join('\n');
  $('s-soon-days').value = s.soonDays;
  const t = state.tally;
  $('tally').textContent = t.used || t.binned
    ? `So far: ${t.used} used up, ${t.binned} thrown away.` : '';

  const last = await db.get('meta', 'lastBackup');
  $('backup-status').textContent = last
    ? `Last backup: ${new Date(last).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}. Save backups to Files or iCloud Drive; deleting the app from the Home Screen deletes its data.`
    : 'No backup yet. Deleting the app from the Home Screen deletes its data, so save one now and then.';

  const pageVersion = document.querySelector('meta[name="app-version"]')?.content;
  $('version-status').textContent = `Installed version: ${versionNumber()}.`
    + (pageVersion === APP_VERSION ? '' : ' Some files are from another version: open the app again while online, or tap Check for updates.');
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  $('storage-status').textContent = [
    est?.usage != null ? `Using about ${Math.max(1, Math.round(est.usage / 1048576))} MB.` : '',
    persisted ? 'Storage is marked persistent.' : 'On iPhone, open the app from its Home Screen icon so its storage is kept.',
  ].filter(Boolean).join(' ');
}

const lines = (text) => [...new Set(text.split('\n').map((l) => l.trim()).filter(Boolean))];

$('settings').addEventListener('change', async (e) => {
  const s = state.settings;
  switch (e.target.id) {
    case 's-owner': s.owner = e.target.value.trim(); $('s-name').placeholder = s.owner ? `${s.owner}'s Kitchen Inventory` : ''; break;
    case 's-name': s.kitchenName = e.target.value.trim(); break;
    case 's-auto-read': s.autoRead = e.target.checked; break;
    case 's-model': s.model = e.target.value; break;
    case 's-locations': s.locations = lines(e.target.value).length ? lines(e.target.value) : DEFAULT_LOCATIONS; break;
    case 's-types': s.types = lines(e.target.value).length ? lines(e.target.value) : DEFAULT_TYPES; break;
    case 's-soon-days': s.soonDays = Math.max(0, Math.min(14, Number(e.target.value) || 0)); break;
    case 's-api-key':
      state.apiKey = e.target.value.trim();
      await db.set('meta', 'apiKey', state.apiKey);
      if (state.apiKey && !state.apiKey.startsWith('sk-ant-')) toast('That doesn\'t look like a Claude API key (they start with sk-ant-).', 5000);
      return;
    default: return;
  }
  await saveSettings();
  render();
});

$('settings-btn').addEventListener('click', async () => {
  await renderSettings();
  openSheet($('settings'));
});

// ---------- version & updates ----------
// iOS freezes a Home Screen app as soon as it's closed, so an update only downloads while
// the app is open. The status next to the version says when it's safe to close.

function setUpdateStatus(text, working = false) {
  for (const el of document.querySelectorAll('.update-status')) {
    el.textContent = text ? `· ${text}` : '';
    el.classList.toggle('working', working);
  }
}

function watchInstall(worker, firstInstall) {
  const show = () => {
    if (worker.state === 'installing') {
      setUpdateStatus(firstInstall ? 'Saving for offline use, keep the app open…' : 'Downloading update, keep the app open…', true);
    } else if (worker.state === 'redundant') {
      setUpdateStatus('Update didn\'t finish, it will try again next time');
    } else if (worker.state === 'activated') {
      setUpdateStatus(firstInstall ? 'Ready to use offline' : 'Update installed, restarting…');
    }
  };
  worker.addEventListener('statechange', show);
  show();
}

async function startUpdates() {
  for (const el of document.querySelectorAll('.app-version')) el.textContent = `· v${versionNumber()}`;
  if (!('serviceWorker' in navigator)) return;

  // When a new version takes over, switch to it straight away unless you're in the middle of
  // editing an item, in which case say so instead of losing what you typed.
  const hadVersion = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadVersion) return; // first install, not an update
    if (!document.querySelector('dialog[open]')) location.reload();
    else toast('A new version is ready. Close and reopen the app to use it.', 8000);
  });

  // Listen on the existing registration before asking for a check, so a download that
  // starts (or fails) in the meantime can't slip past and be reported as "Up to date".
  let reg = await navigator.serviceWorker.getRegistration().catch(() => null);
  const firstInstall = !reg?.active;
  if (!reg) {
    try {
      reg = await navigator.serviceWorker.register('sw.js');
    } catch {
      return;
    }
  }
  reg.addEventListener('updatefound', () => watchInstall(reg.installing, firstInstall));
  if (reg.installing) return watchInstall(reg.installing, firstInstall);

  setUpdateStatus('Checking for updates…', true);
  try {
    await reg.update();
  } catch {
    return setUpdateStatus('Offline');
  }
  if (!reg.installing && !reg.waiting) setUpdateStatus('Up to date');
}

$('update-btn').addEventListener('click', async () => {
  const reg = await navigator.serviceWorker?.getRegistration().catch(() => null);
  if (!reg) return toast('Updates need the app to be opened from its web address first.');
  const btn = $('update-btn');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    await reg.update();
    toast(reg.installing || reg.waiting
      ? 'Downloading the update. Close the app and open it again in a moment.'
      : 'You have the latest version.', 6000);
  } catch {
    toast('Couldn\'t check for updates. Are you online?');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Check for updates';
  }
});

// ---------- start-up ----------

async function start() {
  startUpdates();
  try { state.sort = localStorage.getItem('sort') || 'name'; } catch { /* private mode */ }
  $('sort').value = state.sort;
  await loadSettings();
  await loadData();
  render();
  // Expiry wording ("tomorrow", "today") changes at midnight; refresh when the app comes back.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
}

start();
