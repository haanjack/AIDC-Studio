import { n, polygon, polyline, text, type Pt, type Style, type TextOpts } from './svg.ts';

/**
 * 30°/30° axonometric projection (hall-local, Z-up metres → paper mm) and painter's-order primitives.
 *
 *   x → (cos30·x, −sin30·x)   y → (−cos30·y, −sin30·y)   z → (0, −z)
 *
 * The viewer stands at (−x, −y, +z): the −x face (left) and the −y face (right) of a box are visible together
 * with its top. Depth along the view vector (1, 1, −1) is x + y − z; primitives are sorted far → near.
 */

const C30 = Math.cos(Math.PI / 6);
const S30 = 0.5;

export interface IsoFrame {
  /** paper mm per metre */
  scale: number;
  /** paper origin of hall point (0,0,0) */
  ox: number;
  oy: number;
}

export function isoPoint(f: IsoFrame, x: number, y: number, z: number): Pt {
  return [f.ox + f.scale * C30 * (x - y), f.oy + f.scale * (-S30 * (x + y) - z)];
}

/** Paper extents of a box region (used to size a layer). */
export function isoExtent(w: number, d: number, h: number, scale: number): { width: number; height: number; left: number; top: number } {
  // x from 0..w, y from 0..d, z 0..h
  const left = -C30 * d * scale;
  const right = C30 * w * scale;
  const top = (-S30 * (w + d) - h) * scale;
  const bottom = 0;
  return { width: right - left, height: bottom - top, left, top };
}

export interface IsoPrim {
  depth: number;
  /** explicit layering inside the same depth band (higher on top) */
  z?: number;
  svg: string;
}

export class IsoScene {
  private prims: IsoPrim[] = [];
  constructor(public frame: IsoFrame) {}

  add(depth: number, svg: string, z = 0): void {
    this.prims.push({ depth, svg, z });
  }

  /** flat polygon on a horizontal plane (floor slab, containment outline, zones) */
  flat(pts: { x: number; y: number }[], z: number, st: Style, depthBias = 0): void {
    if (pts.length < 3) return;
    const pp = pts.map((p) => isoPoint(this.frame, p.x, p.y, z));
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    this.add(cx + cy - z + depthBias, polygon(pp, st));
  }

  /** open polyline in 3D */
  line(pts: { x: number; y: number; z: number }[], st: Style, depthBias = 0): void {
    if (pts.length < 2) return;
    const pp = pts.map((p) => isoPoint(this.frame, p.x, p.y, p.z));
    const c = pts.reduce((s, p) => s + p.x + p.y - p.z, 0) / pts.length;
    this.add(c + depthBias, polyline(pp, { ...st, linejoin: st.linejoin ?? 'round', linecap: st.linecap ?? 'round' }));
  }

  /** axis-aligned box: min corner (x, y, z), size (w, d, h). Three visible faces with shaded tints. */
  box(x: number, y: number, z: number, w: number, d: number, h: number, fill: string, opts: { stroke?: string; sw?: number; opacity?: number; dash?: string; depthBias?: number; shade?: boolean } = {}): void {
    const f = this.frame;
    const P = (px: number, py: number, pz: number) => isoPoint(f, px, py, pz);
    const top: Pt[] = [P(x, y, z + h), P(x + w, y, z + h), P(x + w, y + d, z + h), P(x, y + d, z + h)];
    const left: Pt[] = [P(x, y, z), P(x, y + d, z), P(x, y + d, z + h), P(x, y, z + h)]; // −x face
    const right: Pt[] = [P(x, y, z), P(x + w, y, z), P(x + w, y, z + h), P(x, y, z + h)]; // −y face
    const shade = opts.shade ?? true;
    const st = (tint: number): Style => ({
      fill: shade ? mix(fill, '#000000', tint) : fill,
      stroke: opts.stroke ?? mix(fill, '#000000', 0.45),
      sw: opts.sw ?? 0.15,
      opacity: opts.opacity,
      dash: opts.dash,
      linejoin: 'round',
    });
    const depth = x + w / 2 + (y + d / 2) - (z + h / 2) + (opts.depthBias ?? 0);
    this.add(depth, polygon(left, st(0.22)) + polygon(right, st(0.1)) + polygon(top, st(0)));
  }

  /** a pipe: 3D polyline stroked with a width proportional to its radius */
  pipe(pts: { x: number; y: number; z: number }[], radiusM: number, color: string, opts: { opacity?: number; depthBias?: number } = {}): void {
    const sw = Math.max(0.35, 2 * radiusM * this.frame.scale);
    this.line(pts, { stroke: mix(color, '#000000', 0.25), sw: sw + 0.25, opacity: opts.opacity, linecap: 'round' }, opts.depthBias);
    this.line(pts, { stroke: color, sw, opacity: opts.opacity, linecap: 'round' }, (opts.depthBias ?? 0) - 1e-4);
  }

  /** flat-ish slab along a polyline (trays, busways): rendered as a box per segment */
  run(pts: { x: number; y: number; z: number }[], widthM: number, heightM: number, fill: string, opts: { opacity?: number; depthBias?: number; stroke?: string } = {}): void {
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      if (Math.abs(dx) >= Math.abs(dy)) {
        const x0 = Math.min(a.x, b.x);
        this.box(x0, a.y - widthM / 2, a.z, Math.abs(dx) || widthM, widthM, heightM, fill, { opacity: opts.opacity, depthBias: opts.depthBias, stroke: opts.stroke });
      } else {
        const y0 = Math.min(a.y, b.y);
        this.box(a.x - widthM / 2, y0, a.z, widthM, Math.abs(dy) || widthM, heightM, fill, { opacity: opts.opacity, depthBias: opts.depthBias, stroke: opts.stroke });
      }
    }
  }

  /** an arrow along a 3D polyline (air paths) */
  arrow(pts: { x: number; y: number; z: number }[], color: string, sw = 0.5, opts: { opacity?: number; depthBias?: number; dash?: string } = {}): void {
    if (pts.length < 2) return;
    this.line(pts, { stroke: color, sw, opacity: opts.opacity, dash: opts.dash }, opts.depthBias);
    const a = pts[pts.length - 2];
    const b = pts[pts.length - 1];
    const pa = isoPoint(this.frame, a.x, a.y, a.z);
    const pb = isoPoint(this.frame, b.x, b.y, b.z);
    const vx = pb[0] - pa[0];
    const vy = pb[1] - pa[1];
    const len = Math.hypot(vx, vy) || 1;
    const ux = vx / len;
    const uy = vy / len;
    const s = Math.max(1.2, sw * 3);
    const head: Pt[] = [pb, [pb[0] - ux * s - uy * s * 0.5, pb[1] - uy * s + ux * s * 0.5], [pb[0] - ux * s + uy * s * 0.5, pb[1] - uy * s - ux * s * 0.5]];
    this.add(b.x + b.y - b.z + (opts.depthBias ?? 0) - 1e-3, polygon(head, { fill: color, opacity: opts.opacity }));
  }

  label(x: number, y: number, z: number, s: string, o: TextOpts = {}): void {
    const p = isoPoint(this.frame, x, y, z);
    this.add(-1e9, text(p[0], p[1], s, o)); // labels always on top
  }

  /** emit in painter's order (far → near) */
  render(): string {
    const sorted = [...this.prims].sort((a, b) => b.depth - a.depth || (a.z ?? 0) - (b.z ?? 0));
    return sorted.map((p) => p.svg).join('');
  }
}

/** hex colour mix (t → toward `to`) */
export function mix(from: string, to: string, t: number): string {
  const a = hex(from);
  const b = hex(to);
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return `#${c.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`;
}

function hex(s: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(s.trim());
  if (!m) return [128, 128, 128];
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export { n as isoNum };
