import { afterEach, describe, expect, it } from 'vitest';
import {
  CATALOG, CATALOG_IMAGE_MAX_BYTES, catalogImage, catalogImageDataUrlBytes, catalogSchematicSvg, composeRack, findNodeSpec, getCatalogItem, setCatalogThumbnails,
  type CatalogItem,
} from '../src/index.ts';

/** Minimal XML well-formedness check: balanced tags, quoted attributes, no raw '<' / '&' in text. */
function wellFormed(xml: string): string | null {
  const stack: string[] = [];
  const re = /<\/?([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>|([^<]+)/g;
  let pos = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (m.index !== pos) return `unparsed at ${pos}: ${xml.slice(pos, pos + 40)}`;
    pos = re.lastIndex;
    if (m[4] != null) {
      if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;)/.test(m[4])) return `bad entity in text: ${m[4]}`;
      continue;
    }
    const closing = m[0].startsWith('</');
    if (m[3] === '/') continue;
    if (closing) {
      if (stack.pop() !== m[1]) return `mismatched </${m[1]}>`;
    } else stack.push(m[1]);
  }
  if (pos !== xml.length) return `trailing garbage at ${pos}`;
  return stack.length ? `unclosed <${stack.join('> <')}>` : null;
}

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

afterEach(() => setCatalogThumbnails(null));

describe('catalogImage (T5, F6)', () => {
  it('precedence: user attachment > rendered thumbnail > schematic', () => {
    // N1a: thumbnails exist only for registered (manifest-allowlisted) generated models — nothing is assumed before registration
    setCatalogThumbnails({ 'generic_rack_orw_44ou_dlc.glb': 'thumbs/generic_rack_orw_44ou_dlc.png' });
    const gb300 = getCatalogItem('amd-helios-mi455x');
    expect(catalogImage(gb300)).toMatchObject({ kind: 'thumbnail', src: '/assets/thumbs/generic_rack_orw_44ou_dlc.png' });
    const withUser: CatalogItem = { ...gb300, image: { kind: 'user', dataUrl: png, credit: 'site photo' } };
    expect(catalogImage(withUser)).toMatchObject({ kind: 'user', src: png, credit: 'site photo' });
    const noGlb: CatalogItem = { ...gb300, asset: { color: '#333' } };
    const s = catalogImage(noGlb)!;
    expect(s.kind).toBe('schematic');
    expect(s.src.startsWith('data:image/svg+xml')).toBe(true);
    // a user image of an unsupported type is ignored
    expect(catalogImage({ ...gb300, image: { kind: 'user', dataUrl: 'data:image/gif;base64,R0lGOD==' } })!.kind).toBe('thumbnail');
  });

  it('without a registered thumbnail map every item gets its schematic (no guessed /assets/thumbs URL)', () => {
    for (const id of ['nvidia-gb300-nvl72', 'amd-helios-mi455x', 'vertiv-xdu2300', 'vertiv-cw375']) {
      const img = catalogImage(getCatalogItem(id))!;
      expect(img.kind, id).toBe('schematic');
      expect(img.src, id).not.toContain('/assets/thumbs/');
    }
  });

  it('uses the manifest thumbs map once registered (unlisted model → schematic)', () => {
    setCatalogThumbnails({ 'generic_rack_orw_44ou_dlc.glb': 'thumbs/generic_rack_orw_44ou_dlc.png' }, '/assets');
    expect(catalogImage(getCatalogItem('amd-helios-mi455x'))).toMatchObject({ kind: 'thumbnail', src: '/assets/thumbs/generic_rack_orw_44ou_dlc.png' });
    expect(catalogImage(getCatalogItem('nvidia-gb300-nvl72'))!.kind).toBe('schematic');
  });

  it('data URL size / type check', () => {
    expect(catalogImageDataUrlBytes(png)).toBeGreaterThan(40);
    expect(catalogImageDataUrlBytes('data:image/svg+xml;base64,AAAA')).toBe(-1);
    const big = `data:image/jpeg;base64,${'A'.repeat(Math.ceil((CATALOG_IMAGE_MAX_BYTES + 10) / 3) * 4)}`;
    expect(catalogImageDataUrlBytes(big)).toBeGreaterThan(CATALOG_IMAGE_MAX_BYTES);
  });

  it('schematic SVG is well-formed and deterministic for every seed', () => {
    expect(CATALOG.length).toBeGreaterThan(60);
    for (const item of CATALOG) {
      const svg = catalogSchematicSvg(item);
      expect(wellFormed(svg), item.id).toBeNull();
      expect(svg, item.id).toContain('viewBox="0 0 240 300"');
      expect(svg, item.id).not.toMatch(/NaN|undefined|Infinity/);
      expect(catalogSchematicSvg(item)).toBe(svg);
      const url = catalogImage({ ...item, asset: undefined })!;
      expect(url.kind).toBe('schematic');
      expect(decodeURIComponent(url.src.split(',')[1])).toBe(svg);
    }
  });

  it('schematic draws composed racks from their U-map and escapes names', () => {
    const r = composeRack({ node: findNodeSpec('hgx-b300-node')!, nodesPerRack: 4, powerShelves: { count: 2, ratingKW: 33 }, name: 'A & B <test>' });
    const svg = catalogSchematicSvg(r);
    expect(wellFormed(svg)).toBeNull();
    expect(svg).toContain('A &amp; B &lt;test&gt;');
    expect(svg).toContain('48 U');
    expect((svg.match(/fill="#3987e5"/g) ?? []).length).toBe(4); // four node blocks
    expect((svg.match(/fill="#199e70"/g) ?? []).length).toBe(2); // two shelves
  });
});
