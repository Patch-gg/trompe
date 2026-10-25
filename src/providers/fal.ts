import { fal } from '@fal-ai/client';
import type { EditInput, EditModel } from './models';

/**
 * fal access. Without a key the client talks to the dev server's proxy (/api/fal/proxy), which adds the key
 * from FAL_KEY server-side; with a key (bring your own) it calls fal directly from the browser.
 */
let direct = false;

export function configureFal(key?: string) {
  direct = !!key;
  if (key) fal.config({ credentials: key });
  else fal.config({ proxyUrl: '/api/fal/proxy' });
}

function mediaUrl(url: string) {
  return direct ? url : `/api/fal/media?url=${encodeURIComponent(url)}`;
}

export interface EditResult {
  image: ImageBitmap;
  seconds: number;
  requestId: string;
  /** What the model says it ran (Fibo: the expanded VGL), for debugging prompts. */
  expanded?: unknown;
}

export async function runEdit(model: EditModel, input: EditInput, signal?: AbortSignal): Promise<EditResult> {
  const t0 = performance.now();
  const r = await fal.subscribe(model.endpoint, { input: model.input(input), logs: false, abortSignal: signal });
  const data = r.data as { images?: { url: string }[]; image?: { url: string }; vgl?: unknown };
  const url = data.images?.[0]?.url ?? data.image?.url;
  if (!url) throw new Error(`${model.label} returned no image`);
  const res = await fetch(mediaUrl(url), { signal });
  if (!res.ok) throw new Error(`fetching ${model.label} output failed: ${res.status}`);
  const image = await createImageBitmap(await res.blob());
  return { image, seconds: (performance.now() - t0) / 1000, requestId: r.requestId, expanded: data.vgl };
}
