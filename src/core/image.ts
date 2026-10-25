/** Small helpers between RGBA arrays, canvases, bitmaps and data URLs (browser main thread). */

export function toCanvas(data: Uint8ClampedArray, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(data), w, h), 0, 0);
  return c;
}

export function toDataUrl(data: Uint8ClampedArray, w: number, h: number, type = 'image/png', quality = 0.95): string {
  return toCanvas(data, w, h).toDataURL(type, quality);
}

export function toBlob(data: Uint8ClampedArray, w: number, h: number, type = 'image/png', quality = 0.95): Promise<Blob> {
  return new Promise((resolve, reject) =>
    toCanvas(data, w, h).toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), type, quality));
}

/** Draw a bitmap scaled to w x h and return its pixels (top-down RGBA). */
export function bitmapToRGBA(bmp: ImageBitmap | HTMLImageElement, w: number, h: number): Uint8ClampedArray {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}

export async function urlToRGBA(url: string, w: number, h: number): Promise<Uint8ClampedArray> {
  const res = await fetch(url);
  const bmp = await createImageBitmap(await res.blob());
  return bitmapToRGBA(bmp, w, h);
}
