// Catalog images (stream T5, DECISIONS-v2-2 F6).
//
// Priority: user attachment (`item.image.kind === 'user'` with a dataUrl) → rendered thumbnail of the item's GLB
// (/assets/thumbs/<model>.png from tools/asset-pipeline/render_thumbs.py, listed in assets/manifest.json `thumbs` for a
// redistributable generated model — see allowedThumbnails() in ./assetManifest.ts) → front schematic SVG generated
// deterministically from dims + U-map / compute (data: URL, kind 'schematic'). Nothing is guessed: without a registered
// thumbnail map every item gets its schematic (no request for a thumbnail that may not exist).
// Vendor product photos are never embedded (licence) — the catalog detail keeps `item.links` instead.
import type { CatalogItem } from '../model/types.ts';
import { rackUMap } from '../drawings/elevation.ts';
import type { UMapEntry } from './compose.ts';

export type CatalogImageKind = 'thumbnail' | 'schematic' | 'user';

export interface CatalogImage {
  kind: CatalogImageKind;
  src: string;
  /** provenance line shown under the image */
  credit?: string;
}

/** Accepted user image types and size cap (bytes of the decoded file); mirrored by apps/server/src/catalogStore.ts. */
export const CATALOG_IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const CATALOG_IMAGE_MAX_BYTES = 1024 * 1024;

/** Decoded byte length of a base64 data URL, or -1 when it is not an accepted `data:image/(png|jpeg|webp);base64,` URL. */
export function catalogImageDataUrlBytes(dataUrl: string): number {
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl);
  if (!m) return -1;
  const b64 = m[2];
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

let thumbIndex: Record<string, string> | null = null;
let thumbBase = '/assets/';

/**
 * Register the rendered thumbnails (assets/manifest.json `thumbs` filtered by allowedThumbnails():
 * `{ "generic_rack_orw_44ou_dlc.glb": "thumbs/generic_rack_orw_44ou_dlc.png" }`). Only listed models get a thumbnail; before registration none do.
 */
export function setCatalogThumbnails(map: Record<string, string> | null, base = '/assets/'): void {
  thumbIndex = map;
  thumbBase = base.endsWith('/') ? base : `${base}/`;
}

function thumbnailFor(glb: string): string | undefined {
  const name = glb.split('/').pop()!;
  const rel = thumbIndex?.[name];
  return rel ? `${thumbBase}${rel}` : undefined;
}

export function catalogImage(item: CatalogItem): CatalogImage | undefined {
  const img = item.image;
  if (img?.kind === 'user' && img.dataUrl && catalogImageDataUrlBytes(img.dataUrl) >= 0) {
    return { kind: 'user', src: img.dataUrl, credit: img.credit || 'User attachment' };
  }
  if (img?.kind === 'thumbnail' && img.src) return { kind: 'thumbnail', src: img.src, credit: img.credit };
  const glb = item.asset?.glb;
  const thumb = glb ? thumbnailFor(glb) : undefined;
  if (thumb) return { kind: 'thumbnail', src: thumb, credit: `3D render of the generated model ${glb} (render_thumbs.py)` };
  return { kind: 'schematic', src: svgDataUrl(catalogSchematicSvg(item)), credit: 'Schematic from dimensions and U-map (not a product photo)' };
}

export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// ───────────── schematic ─────────────

const esc = (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const f1 = (x: number) => (Math.round(x * 10) / 10).toString();

/** Tray / block colours by type (dark theme categorical slots, apps/web/src/styles/theme.css). */
export const SCHEMATIC_COLORS = {
  compute: '#3987e5',
  node: '#3987e5',
  switch: '#c98500',
  power: '#199e70',
  'power-shelf': '#199e70',
  pdu: '#199e70',
  mgmt: '#9085e9',
  storage: '#d55181',
  server: '#5a8fd0',
  controller: '#b06aa0',
  leaf: '#c98500',
  spine: '#d95926',
  core: '#e66767',
  patch: '#6b7280',
  blank: '#2a2f36',
  free: '#2a2f36',
  other: '#4a5058',
} as const;

export interface CatalogRackBand { u0: number; units: number; kind: string; label: string; id?: string; kw?: number; ref?: string }
type Band = CatalogRackBand;

/** Front U stack of a rack item: the composer U-map when present, else the planning U-map of drawings/elevation.ts (one band per unit block). */
export function catalogRackLayout(item: CatalogItem): { totalU: number; unit: 'U' | 'OU'; bands: CatalogRackBand[] } | undefined {
  return rackBands(item);
}

function rackBands(item: CatalogItem): { totalU: number; unit: 'U' | 'OU'; bands: Band[] } | undefined {
  const umap = item.meta?.umap as UMapEntry[] | undefined;
  const cap = Number(item.meta?.ruCap ?? item.rackUnits ?? 0);
  if (Array.isArray(umap) && umap.length && cap > 0) {
    const ou = item.meta?.rackForm === 'orv3-21' || item.meta?.rackForm === 'orw-double-wide';
    return { totalU: cap, unit: ou ? 'OU' : 'U', bands: umap.map((e) => ({ u0: e.u, units: e.units, kind: e.kind, label: e.label, ...(e.id ? { id: e.id } : {}), ...(e.kw != null ? { kw: e.kw } : {}), ...(e.ref ? { ref: e.ref } : {}) })) };
  }
  const isRack = /-rack$/.test(item.category);
  if (!isRack) return undefined;
  const m = rackUMap(item, 'en');
  const bands: Band[] = [];
  for (const b of m.blocks) for (let i = 0; i < b.count; i++) bands.push({ u0: b.u0 + i * b.units, units: b.units, kind: b.kind, label: b.label });
  return { totalU: m.totalU, unit: m.unit, bands };
}

const W = 240;
const H = 300;

/** Deterministic front-elevation SVG (240 × 300 viewBox) for any catalog item. */
export function catalogSchematicSvg(item: CatalogItem): string {
  const parts: string[] = [];
  const dimsText = `${Math.round(item.dims.w * 1000)} × ${Math.round(item.dims.d * 1000)} × ${Math.round(item.dims.h * 1000)} mm`;
  // drawing area (leave room for the caption)
  const areaW = W - 40;
  const areaH = H - 70;
  const aspect = item.dims.w / Math.max(0.01, item.dims.h);
  let fw = areaW;
  let fh = fw / aspect;
  if (fh > areaH) { fh = areaH; fw = fh * aspect; }
  fw = Math.max(fw, 24);
  fh = Math.max(fh, 12);
  const x0 = (W - fw) / 2;
  const y0 = 14 + (areaH - fh) / 2;
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#1b1f24"/>`);
  const rack = rackBands(item);
  if (rack) {
    parts.push(`<rect x="${f1(x0)}" y="${f1(y0)}" width="${f1(fw)}" height="${f1(fh)}" fill="#14171b" stroke="#b3b8bf" stroke-width="1.2"/>`);
    const post = Math.max(3, fw * 0.06);
    const cap = Math.max(4, fh * 0.03);
    const ix = x0 + post;
    const iw = fw - 2 * post;
    const iy = y0 + cap;
    const ih = fh - 2 * cap;
    const pu = ih / Math.max(1, rack.totalU);
    parts.push(`<rect x="${f1(x0)}" y="${f1(y0)}" width="${f1(post)}" height="${f1(fh)}" fill="#3a4048"/>`);
    parts.push(`<rect x="${f1(x0 + fw - post)}" y="${f1(y0)}" width="${f1(post)}" height="${f1(fh)}" fill="#3a4048"/>`);
    for (const b of [...rack.bands].sort((a, c) => a.u0 - c.u0)) {
      const color = (SCHEMATIC_COLORS as Record<string, string>)[b.kind] ?? SCHEMATIC_COLORS.other;
      const by = iy + ih - (b.u0 - 1 + b.units) * pu;
      const bh = b.units * pu;
      const blank = b.kind === 'blank' || b.kind === 'free';
      parts.push(`<rect x="${f1(ix)}" y="${f1(by)}" width="${f1(iw)}" height="${f1(Math.max(0.6, bh - Math.min(0.8, pu * 0.15)))}" fill="${color}" fill-opacity="${blank ? 1 : 0.85}"${blank ? ' stroke="#3a4048" stroke-width="0.4"' : ''}/>`);
    }
    parts.push(`<text x="${f1(x0 + fw + 4)}" y="${f1(y0 + 8)}" font-size="8" fill="#858b93" font-family="sans-serif">${rack.totalU} ${rack.unit}</text>`);
  } else {
    const cat = item.category;
    parts.push(`<rect x="${f1(x0)}" y="${f1(y0)}" width="${f1(fw)}" height="${f1(fh)}" rx="2" fill="#23282f" stroke="#b3b8bf" stroke-width="1.2"/>`);
    if (cat === 'switch' || cat === 'nic') {
      const ports = Math.min(64, Math.max(4, item.switch?.ports ?? item.nic?.ports ?? 8));
      const cols = Math.min(32, Math.ceil(ports / 2));
      const pw = (fw - 12) / cols;
      for (let r = 0; r < 2; r++) for (let c = 0; c < cols; c++) {
        parts.push(`<rect x="${f1(x0 + 6 + c * pw + pw * 0.15)}" y="${f1(y0 + fh * (0.2 + r * 0.35))}" width="${f1(pw * 0.7)}" height="${f1(fh * 0.25)}" fill="${SCHEMATIC_COLORS.switch}"/>`);
      }
    } else {
      // louvres / grille for facility units, a status panel in the upper third
      const lines = Math.max(4, Math.min(24, Math.round(fh / 8)));
      for (let i = 1; i < lines; i++) {
        const y = y0 + fh * 0.35 + ((fh * 0.6) / lines) * i;
        parts.push(`<line x1="${f1(x0 + fw * 0.08)}" y1="${f1(y)}" x2="${f1(x0 + fw * 0.92)}" y2="${f1(y)}" stroke="#4a5058" stroke-width="0.8"/>`);
      }
      const panel = /cdu|crah|ups|chiller|rpp|switchgear|battery/.test(cat) ? SCHEMATIC_COLORS.power : SCHEMATIC_COLORS.other;
      parts.push(`<rect x="${f1(x0 + fw * 0.08)}" y="${f1(y0 + fh * 0.08)}" width="${f1(fw * 0.3)}" height="${f1(fh * 0.18)}" fill="${panel}" fill-opacity="0.8"/>`);
    }
  }
  const name = item.name.length > 40 ? `${item.name.slice(0, 39)}…` : item.name;
  parts.push(`<text x="${W / 2}" y="${H - 38}" font-size="10.5" font-weight="600" text-anchor="middle" fill="#f2f3f4" font-family="sans-serif">${esc(name)}</text>`);
  parts.push(`<text x="${W / 2}" y="${H - 24}" font-size="9" text-anchor="middle" fill="#b3b8bf" font-family="sans-serif">${esc(dimsText)}</text>`);
  parts.push(`<text x="${W / 2}" y="${H - 10}" font-size="8" text-anchor="middle" fill="#858b93" font-family="sans-serif" letter-spacing="1">SCHEMATIC</text>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(`${item.name} schematic`)}">${parts.join('')}</svg>`;
}
