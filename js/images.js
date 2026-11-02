// Shrinks camera photos before they're stored or sent: a phone photo is 3-12 MB, a label
// is perfectly readable at 1280 px, and the list only needs a small square.

async function decode(blob) {
  // createImageBitmap applies the photo's EXIF rotation, so portrait shots stay upright.
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch { /* fall back to <img> (older Safari, HEIC on some Androids) */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function toJpeg(canvas, quality) {
  return new Promise((resolve, reject) => canvas.toBlob(
    (b) => (b ? resolve(b) : reject(new Error('Couldn\'t process the photo'))), 'image/jpeg', quality));
}

function draw(src, w, h, sx = 0, sy = 0, sw = src.width, sh = src.height) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
  return c;
}

/** Returns { photo, thumb } JPEG blobs: photo fits in 1280 px, thumb is a 240 px square. */
export async function preparePhoto(file) {
  const img = await decode(file);
  const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
  const photo = await toJpeg(draw(img, Math.round(img.width * scale), Math.round(img.height * scale)), 0.82);
  const side = Math.min(img.width, img.height);
  const thumb = await toJpeg(draw(img, 240, 240, (img.width - side) / 2, (img.height - side) / 2, side, side), 0.75);
  img.close?.();
  return { photo, thumb };
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export function base64ToBlob(b64, type = 'image/jpeg') {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}
