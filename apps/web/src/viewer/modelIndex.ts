// Which GLB models the viewer may request (neutralization N1a, LICENSE-AUDIT R-1.2).
//
// The viewer only fetches a model file when /assets/manifest.json lists it as a redistributable generated model
// (`allowedModelFiles`: `generated: true` + `license`). A catalog item whose `asset.glb` is not listed — including every
// item when the manifest itself is missing — keeps its procedural model, without a network request (no 404 noise).
// Pure module (no three.js) so apps/server/test can exercise it.
import { allowedModelFiles, type AssetManifest } from '@aidc/core';

type Fetcher = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

let index: Promise<Set<string>> | null = null;

/** Load (once) the set of allowed GLB file names from the asset manifest; an unreadable manifest yields an empty set. */
export function loadModelIndex(url = '/assets/manifest.json', fetcher: Fetcher = (u) => fetch(u)): Promise<Set<string>> {
  index ??= (async () => {
    try {
      const res = await fetcher(url);
      if (!res.ok) return new Set<string>();
      return allowedModelFiles((await res.json()) as AssetManifest);
    } catch {
      return new Set<string>();
    }
  })();
  return index;
}

/** Replace the cached index (tests, harness); `null` forces a reload on the next lookup. */
export function setModelIndex(files: Iterable<string> | null): void {
  index = files ? Promise.resolve(new Set(files)) : null;
}

/** GLB file name of a model URL (`/assets/models/x.glb?v=1` → `x.glb`). */
export function modelFileOf(url: string): string {
  const path = url.split(/[?#]/)[0];
  return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1));
}

/** True when the model URL points at a manifest-listed redistributable model. */
export async function isModelAllowed(url: string, fetcher?: Fetcher): Promise<boolean> {
  const files = await loadModelIndex(undefined, fetcher);
  return files.has(modelFileOf(url));
}
