import { findCatalogItem } from '../catalog/catalog.ts';
import type { Containment, EquipmentInstance, Hall, Project } from '../model/types.ts';
import { CATEGORY_COLORS, hexToRgb, primName, r4, selectHalls, uniqueNamer, type Tuple3 } from './transforms.ts';

export interface UsdExportOptions {
  hallId?: string;
  includeLights?: boolean;
  /**
   * Root of the AIDC-generated USD assets (catalog `asset.usd` paths starting with `usd/`, e.g. 'usd/Generic/generic_rack_orw_44ou_dlc.usd'
   * built by tools/asset-pipeline into apps/web/public/assets). Default '../apps/web/public/assets'.
   * No third-party asset library is referenced: every other catalog item is exported as a sized, coloured Cube.
   */
  generatedAssetRoot?: string;
}

/**
 * Native-front correction for a referenced AIDC-generated asset, so the AIDC convention holds (Z-up, metres, footprint
 * centre at the origin, FRONT faces +Y at rotation 0). Generated assets are authored front toward +X → rotateZ +90°.
 */
export interface UsdAssetInfo {
  hasGeometry: boolean;
  /** extra ops on the correction Xform, outermost → innermost (USD xformOpOrder semantics) */
  ops: { op: string; type: 'double' | 'double3'; value: number | Tuple3 }[];
}

const ROT90: UsdAssetInfo = { hasGeometry: true, ops: [{ op: 'xformOp:rotateZ:nativeFront', type: 'double', value: 90 }] };

export const USD_ASSET_INFO: Record<string, UsdAssetInfo> = {
  // AIDC-generated generic form-factor models (tools/asset-pipeline/generic_usd.py) — Z-up, metres, front on +X
  ...Object.fromEntries(
    ['generic_rack_eia48_dlc', 'generic_rack_orv3_44ou_dlc', 'generic_rack_orw_44ou_dlc', 'generic_cdu_900x2122', 'generic_cdu_1200x2400', 'generic_crah_2515x1829',
      'generic_crah_3099x2388', 'generic_crah_3050x3407', 'generic_fanwall_3600x3000'].map((n) => [`usd/Generic/${n}.usd`, ROT90]),
  ),
};

/** True for catalog USD paths of AIDC-generated assets (the only USD files the exporter payloads). */
export function isGeneratedUsdAssetPath(usd: string): boolean {
  return /^usd\//.test(usd);
}

const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

const v3 = (t: Tuple3) => `(${t.map((n) => r4(n)).join(', ')})`;
const ind = (n: number) => '    '.repeat(n);

function joinAssetPath(root: string, rel: string): string {
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
  return `${r}/${rel.replace(/^\/+/, '')}`;
}

function cube(lines: string[], depth: number, name: string, center: Tuple3, size: Tuple3, color: Tuple3, opts: { opacity?: number; invisible?: boolean } = {}) {
  const i = ind(depth);
  lines.push(`${i}def Cube ${q(name)}`, `${i}{`);
  lines.push(`${i}    double size = 1`);
  lines.push(`${i}    float3[] extent = [(-0.5, -0.5, -0.5), (0.5, 0.5, 0.5)]`);
  lines.push(`${i}    color3f[] primvars:displayColor = [${v3(color)}]`);
  if (opts.opacity !== undefined && opts.opacity < 1) lines.push(`${i}    float[] primvars:displayOpacity = [${r4(opts.opacity)}]`);
  if (opts.invisible) lines.push(`${i}    token visibility = "invisible"`);
  lines.push(`${i}    double3 xformOp:translate = ${v3(center)}`);
  lines.push(`${i}    float3 xformOp:scale = ${v3(size)}`);
  lines.push(`${i}    uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:scale"]`);
  lines.push(`${i}}`);
}

function writeShell(lines: string[], d: number, hall: Hall) {
  const grey: Tuple3 = [0.55, 0.57, 0.6];
  const wallC: Tuple3 = [0.8, 0.81, 0.82];
  const H = hall.clearHeight + hall.ceilingPlenumHeight;
  const W = hall.width;
  const D = hall.depth;
  const t = 0.2;
  lines.push(`${ind(d)}def Scope "Shell"`, `${ind(d)}{`);
  cube(lines, d + 1, 'Floor', [W / 2, D / 2, -t / 2], [W, D, t], grey);
  // walls & ceiling authored invisible so the interior stays visible; toggle in the viewer
  cube(lines, d + 1, 'Wall_South', [W / 2, -t / 2, H / 2], [W + 2 * t, t, H], wallC, { invisible: true });
  cube(lines, d + 1, 'Wall_North', [W / 2, D + t / 2, H / 2], [W + 2 * t, t, H], wallC, { invisible: true });
  cube(lines, d + 1, 'Wall_West', [-t / 2, D / 2, H / 2], [t, D, H], wallC, { invisible: true });
  cube(lines, d + 1, 'Wall_East', [W + t / 2, D / 2, H / 2], [t, D, H], wallC, { invisible: true });
  cube(lines, d + 1, 'Ceiling', [W / 2, D / 2, hall.clearHeight + 0.05], [W, D, 0.1], wallC, { invisible: true, opacity: 0.4 });
  lines.push(`${ind(d)}}`);
  if (hall.keepouts.length) {
    lines.push(`${ind(d)}def Scope "Keepouts"`, `${ind(d)}{`);
    const kn = uniqueNamer();
    for (const k of hall.keepouts) {
      const h = k.kind === 'column' || k.kind === 'shaft' ? H : k.kind === 'door' || k.kind === 'egress' ? 2.4 : 0.05;
      cube(lines, d + 1, kn(k.id), [k.rect.x + k.rect.w / 2, k.rect.y + k.rect.d / 2, h / 2], [k.rect.w, k.rect.d, h], k.kind === 'column' ? [0.6, 0.6, 0.6] : [0.9, 0.75, 0.25], { opacity: k.kind === 'column' ? 1 : 0.4 });
    }
    lines.push(`${ind(d)}}`);
  }
}

function writeContainment(lines: string[], d: number, name: string, c: Containment, hall: Hall) {
  const col: Tuple3 = c.kind === 'hot-aisle' ? [1.0, 0.42, 0.24] : [0.24, 0.65, 1.0];
  const { x, y, w, d: dd } = c.rect;
  const i = ind(d);
  lines.push(`${i}def Xform ${q(name)}`, `${i}{`);
  lines.push(`${i}    custom string aidc:kind = ${q(c.kind)}`);
  if (c.podId) lines.push(`${i}    custom string aidc:podId = ${q(c.podId)}`);
  const p = 0.02;
  if (c.roof) cube(lines, d + 1, 'Roof', [x + w / 2, y + dd / 2, c.height + p / 2], [w, dd, p], col, { opacity: 0.3 });
  if (c.endDoors) {
    cube(lines, d + 1, 'Door_West', [x + p / 2, y + dd / 2, c.height / 2], [p, dd, c.height], col, { opacity: 0.3 });
    cube(lines, d + 1, 'Door_East', [x + w - p / 2, y + dd / 2, c.height / 2], [p, dd, c.height], col, { opacity: 0.3 });
  }
  if (c.ductedToPlenum && hall.clearHeight > c.height) {
    const ch = hall.clearHeight - c.height;
    cube(lines, d + 1, 'Chimney', [x + w / 2, y + dd / 2, c.height + ch / 2], [w, dd, ch], col, { opacity: 0.15 });
  }
  lines.push(`${i}}`);
}

function writeEquipment(lines: string[], d: number, name: string, e: EquipmentInstance, opts: Required<Pick<UsdExportOptions, 'generatedAssetRoot'>>) {
  const item = findCatalogItem(e.catalogId);
  const i = ind(d);
  lines.push(`${i}def Xform ${q(name)} (`, `${i}    kind = "component"`, `${i})`, `${i}{`);
  lines.push(`${i}    custom string aidc:id = ${q(e.id)}`);
  lines.push(`${i}    custom string aidc:tag = ${q(e.tag)}`);
  lines.push(`${i}    custom string aidc:catalogId = ${q(e.catalogId)}`);
  lines.push(`${i}    custom string aidc:category = ${q(item?.category ?? 'other')}`);
  lines.push(`${i}    custom double aidc:nameplateKW = ${r4(item?.power?.nameplateKW ?? 0)}`);
  if (e.podId) lines.push(`${i}    custom string aidc:podId = ${q(e.podId)}`);
  if (e.rowId) lines.push(`${i}    custom string aidc:rowId = ${q(e.rowId)}`);
  if (e.waveId) lines.push(`${i}    custom string aidc:waveId = ${q(e.waveId)}`);
  if (e.networkRole) lines.push(`${i}    custom string aidc:networkRole = ${q(e.networkRole)}`);
  lines.push(`${i}    double3 xformOp:translate = ${v3([e.position.x, e.position.y, e.elevation ?? 0])}`);
  lines.push(`${i}    double xformOp:rotateZ = ${r4(e.rotationDeg)}`);
  lines.push(`${i}    uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:rotateZ"]`);

  // only AIDC-generated assets are payloaded; anything else (e.g. a path into a third-party library) exports as a box
  const usd = item?.asset?.usd && isGeneratedUsdAssetPath(item.asset.usd) ? item.asset.usd : undefined;
  const info = usd ? USD_ASSET_INFO[usd] : undefined;
  if (usd && (info?.hasGeometry ?? true)) {
    const ops = info?.ops ?? [];
    lines.push(`${i}    def Xform "Asset"`, `${i}    {`);
    for (const o of ops) lines.push(`${i}        ${o.type} ${o.op} = ${Array.isArray(o.value) ? v3(o.value) : r4(o.value)}`);
    if (ops.length) lines.push(`${i}        uniform token[] xformOpOrder = [${ops.map((o) => q(o.op)).join(', ')}]`);
    lines.push(`${i}        def Xform "Ref" (`, `${i}            instanceable = true`, `${i}            prepend payload = @${joinAssetPath(opts.generatedAssetRoot, usd)}@`, `${i}        )`, `${i}        {`, `${i}        }`);
    lines.push(`${i}    }`);
  } else {
    const dims = item?.dims ?? { w: 0.6, d: 1.2, h: 2.3 };
    const color = hexToRgb(item?.asset?.color ?? CATEGORY_COLORS[item?.category ?? 'other']);
    cube(lines, d + 1, 'Box', [0, 0, dims.h / 2], [dims.w, dims.d, dims.h], color);
  }
  lines.push(`${i}}`);
}

/** USDA stage (Z-up, metersPerUnit=1): hall shell, containment and equipment with `aidc:*` attributes at the designed positions. */
export function exportUsda(project: Project, opts: UsdExportOptions = {}): string {
  const generatedAssetRoot = opts.generatedAssetRoot ?? '../apps/web/public/assets';
  const halls = selectHalls(project, opts.hallId);
  const lines: string[] = [];
  lines.push('#usda 1.0', '(');
  lines.push('    customLayerData = {');
  // dictionary keys containing ':' must be quoted in USDA
  lines.push(`        string "aidc:generator" = "AIDC Studio"`);
  lines.push(`        string "aidc:projectId" = ${q(project.id)}`);
  lines.push(`        string "aidc:projectName" = ${q(project.name)}`);
  lines.push(`        string "aidc:generatedAssetRoot" = ${q(generatedAssetRoot)}`);
  lines.push(`        string "aidc:exportedAt" = ${q(new Date().toISOString())}`);
  lines.push('    }');
  lines.push('    defaultPrim = "World"', '    metersPerUnit = 1', '    upAxis = "Z"', ')', '');
  lines.push('def Xform "World" (', '    kind = "assembly"', ')', '{');

  if (opts.includeLights ?? true) {
    lines.push('    def Scope "Environment"', '    {');
    lines.push('        def DomeLight "Dome"', '        {', '            float inputs:intensity = 800', '        }');
    lines.push('        def DistantLight "Sun"', '        {', '            float inputs:angle = 1', '            float inputs:intensity = 3000', '            double3 xformOp:rotateXYZ = (-45, 0, 30)', '            uniform token[] xformOpOrder = ["xformOp:rotateXYZ"]', '        }');
    lines.push('    }');
  }

  lines.push('    def Xform "Site"', '    {');
  const hallNamer = uniqueNamer();
  for (const hall of halls) {
    const hn = hallNamer(hall.name);
    lines.push(`        def Xform ${q(hn)} (`, '            kind = "group"', '        )', '        {');
    lines.push(`            custom string aidc:hallId = ${q(hall.id)}`);
    lines.push(`            custom double aidc:itPowerBudgetKW = ${r4(hall.itPowerBudgetKW)}`);
    lines.push(`            double3 xformOp:translate = ${v3([hall.origin.x, hall.origin.y, 0])}`);
    lines.push('            uniform token[] xformOpOrder = ["xformOp:translate"]');
    writeShell(lines, 3, hall);

    const conts = project.containments.filter((c) => c.hallId === hall.id);
    if (conts.length) {
      lines.push('            def Scope "Containment"', '            {');
      const cn = uniqueNamer();
      for (const c of conts) writeContainment(lines, 4, cn(c.id), c, hall);
      lines.push('            }');
    }

    const eqs = project.equipment.filter((e) => e.hallId === hall.id);
    const groups = new Map<string, EquipmentInstance[]>();
    for (const e of eqs) {
      const k = e.podId ?? 'room';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(e);
    }
    lines.push('            def Xform "Equipment"', '            {');
    const gn = uniqueNamer();
    for (const [pod, list] of groups) {
      lines.push(`                def Xform ${q(gn(pod))} (`, '                    kind = "group"', '                )', '                {');
      const en = uniqueNamer();
      for (const e of list) writeEquipment(lines, 5, en(e.tag), e, { generatedAssetRoot });
      lines.push('                }');
    }
    lines.push('            }');
    lines.push('        }');
  }
  lines.push('    }', '}', '');
  return lines.join('\n');
}

export { primName };
