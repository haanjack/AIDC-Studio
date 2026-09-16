// Rack blueprint preview (stream T5, DECISIONS-v2-2 F7): fixed frame per rack model (42U / 48U EIA-19, ORV3 / ORW 44 OU,
// posts, rails, U ruler on both sides) with components drawn at their U positions, empty U as blank plates,
// zero-U PDU / busbar zones, dimension text and overflow / overlap in red. The SVG size never changes with the content:
// one fixed px-per-mm scale for every rack model, so a 42U and an ORW frame are directly comparable.
import { useMemo, useState } from 'react';
import { RACK_MODELS, SCHEMATIC_COLORS, catalogRackLayout, findRackModel, type CatalogItem, type RackModel } from '@aidc/core';
import { useT } from '../i18n/index.ts';

export interface RackBlueprintEntry {
  /** lowest U occupied (1-based) */
  u: number;
  heightU: number;
  label: string;
  catalogId?: string;
  // ── T5 optional ──
  id?: string;
  kind?: string;
  kw?: number;
  conflict?: 'overflow' | 'overlap';
}

export interface RackBlueprintProps {
  /** rack model id from RACK_MODELS (catalog/compose.ts) or the composed rack item */
  rackModelId?: string;
  item?: CatalogItem;
  rackUnits?: number;
  entries?: RackBlueprintEntry[];
  /** pixels per U (ignored: the blueprint uses one fixed mm scale so it never resizes) */
  scale?: number;
  // ── T5 optional ──
  /** blocks that could not be placed (drawn as an overflow bar above the frame) */
  overflowU?: number;
  issues?: string[];
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  onMove?: (id: string, dir: 1 | -1) => void;
}

const SVG_W = 460;
const SVG_H = 660;
const MAX_H_MM = 2450;
const MAX_W_MM = 1250;
const TOP_PX = 76; // title, dimension text and the overflow bar live above the frame
const PX_PER_MM = Math.min((SVG_H - TOP_PX - 64) / MAX_H_MM, (SVG_W - 190) / MAX_W_MM);
const EIA_U_MM = 44.45;
const OPEN_U_MM = 48;

interface Frame {
  form: RackModel['form'];
  wMm: number;
  dMm: number;
  hMm: number;
  ru: number;
  pitchMm: number;
  unit: 'U' | 'OU';
  /** usable equipment width between the rails */
  bayMm: number;
  name: string;
}

function resolveFrame(p: RackBlueprintProps): Frame {
  const metaModel = typeof p.item?.meta?.rackModel === 'string' ? (p.item.meta.rackModel as string) : undefined;
  const model = findRackModel(p.rackModelId ?? metaModel ?? '');
  const item = p.item;
  const form: RackModel['form'] = model?.form ?? (item && item.dims.w >= 1 ? 'orw-double-wide' : item?.meta?.rackForm === 'orv3-21' ? 'orv3-21' : 'eia-19');
  const layout = item ? catalogRackLayout(item) : undefined;
  const ru = p.rackUnits ?? model?.rackUnits ?? Number(item?.meta?.ruCap ?? item?.rackUnits ?? layout?.totalU ?? 48);
  const dims = model?.dims ?? item?.dims ?? { w: 0.6, d: 1.2, h: 2.3 };
  const open = form !== 'eia-19';
  const wMm = dims.w * 1000;
  // EIA 19": 450 mm between rails (482.6 mm with ears); ORV3 / ORW IT bay = frame − 62 mm (docs/research/helios.md §4, derived from ORV3 538 / 600 mm)
  const bayMm = open ? wMm - 62 : 450;
  return { form, wMm, dMm: dims.d * 1000, hMm: dims.h * 1000, ru, pitchMm: open ? OPEN_U_MM : EIA_U_MM, unit: open ? 'OU' : 'U', bayMm, name: model?.name ?? item?.name ?? '' };
}

function entriesFromItem(item: CatalogItem): RackBlueprintEntry[] {
  const layout = catalogRackLayout(item);
  if (!layout) return [];
  return layout.bands.filter((b) => b.kind !== 'free' && b.kind !== 'blank').map((b, i) => ({ u: b.u0, heightU: b.units, label: b.label, kind: b.kind, id: b.id ?? `b${i}`, kw: b.kw, catalogId: b.ref }));
}

const colorOf = (kind?: string) => (SCHEMATIC_COLORS as Record<string, string>)[kind ?? 'other'] ?? SCHEMATIC_COLORS.other;
const f = (x: number) => Math.round(x * 10) / 10;

export function RackBlueprint(props: RackBlueprintProps) {
  const t = useT();
  const frame = useMemo(() => resolveFrame(props), [props.rackModelId, props.item, props.rackUnits]); // eslint-disable-line react-hooks/exhaustive-deps
  const entries = useMemo(() => props.entries ?? (props.item ? entriesFromItem(props.item) : []), [props.entries, props.item]);
  const [hover, setHover] = useState<{ e: RackBlueprintEntry; x: number; y: number } | null>(null);

  const s = PX_PER_MM;
  const fw = frame.wMm * s;
  const fh = frame.hMm * s;
  const x0 = (SVG_W - fw) / 2;
  const y0 = TOP_PX + (MAX_H_MM - frame.hMm) * s * 0.5;
  const stackMm = frame.ru * frame.pitchMm;
  const capMm = Math.max(20, (frame.hMm - stackMm) / 2);
  const pu = frame.pitchMm * s;
  const stackTop = y0 + capMm * s;
  const stackBottom = stackTop + frame.ru * pu;
  const bayX = x0 + ((frame.wMm - frame.bayMm) / 2) * s;
  const bayW = frame.bayMm * s;
  const yOfU = (u: number) => stackBottom - (u - 1) * pu; // bottom edge of unit u
  const clampU = (u: number) => Math.max(1, Math.min(frame.ru, u));

  // occupancy → blank plates
  const occ = new Array(frame.ru + 1).fill(false);
  for (const e of entries) for (let k = e.u; k < e.u + e.heightU; k++) if (k >= 1 && k <= frame.ru) occ[k] = true;
  const blanks: number[] = [];
  for (let k = 1; k <= frame.ru; k++) if (!occ[k]) blanks.push(k);

  const selected = props.selectedId ? entries.find((e) => e.id === props.selectedId) : undefined;
  const overflowEntries = entries.filter((e) => e.u + e.heightU - 1 > frame.ru || e.u < 1);
  const overflowU = (props.overflowU ?? 0) + overflowEntries.reduce((a, e) => a + e.heightU, 0);
  const badCount = entries.filter((e) => e.conflict).length + (props.overflowU ? 1 : 0);
  const open = frame.form !== 'eia-19';
  const zeroULabel = open ? t(frame.form === 'orw-double-wide' ? 'catalog.bp.busbarOrw' : 'catalog.bp.busbarOrv3') : t('catalog.bp.zeroUPdu');

  return (
    <div className="rack-blueprint" style={{ position: 'relative', width: SVG_W, height: SVG_H, flex: `0 0 ${SVG_W}px` }} data-rack-blueprint={frame.form}>
      <svg width={SVG_W} height={SVG_H} viewBox={`0 0 ${SVG_W} ${SVG_H}`} role="img" aria-label={t('catalog.bp.aria', { name: frame.name })} style={{ display: 'block', background: '#0f1216', borderRadius: 8, border: '1px solid var(--border)' }} onClick={() => props.onSelect?.(null)}>
        <defs>
          <pattern id="bp-blank" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="#1b1f24" />
            <line x1="0" y1="0" x2="0" y2="6" stroke="#2a2f36" strokeWidth="2" />
          </pattern>
          <pattern id="bp-grid" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#161a1f" strokeWidth="1" />
          </pattern>
        </defs>
        <rect x="0" y="0" width={SVG_W} height={SVG_H} fill="url(#bp-grid)" />
        {/* title + dimension text */}
        <text x={SVG_W / 2} y={18} textAnchor="middle" fontSize="11.5" fontWeight={600} fill="#f2f3f4">{frame.name}</text>
        <text x={SVG_W / 2} y={33} textAnchor="middle" fontSize="10" fill="#b3b8bf">
          {t('catalog.bp.dims', { w: Math.round(frame.wMm), d: Math.round(frame.dMm), h: Math.round(frame.hMm), ru: frame.ru, unit: frame.unit, pitch: frame.pitchMm })}
        </text>
        {/* width dimension line */}
        <line x1={x0} y1={y0 - 8} x2={x0 + fw} y2={y0 - 8} stroke="#6da7ec" strokeWidth="0.8" />
        <line x1={x0} y1={y0 - 12} x2={x0} y2={y0 - 4} stroke="#6da7ec" strokeWidth="0.8" />
        <line x1={x0 + fw} y1={y0 - 12} x2={x0 + fw} y2={y0 - 4} stroke="#6da7ec" strokeWidth="0.8" />
        <text x={x0 + fw / 2} y={y0 - 11} textAnchor="middle" fontSize="8.5" fill="#6da7ec">{Math.round(frame.wMm)} mm</text>
        {/* height dimension line (right) */}
        <line x1={SVG_W - 14} y1={y0} x2={SVG_W - 14} y2={y0 + fh} stroke="#6da7ec" strokeWidth="0.8" />
        <text x={SVG_W - 18} y={y0 + fh / 2} textAnchor="middle" fontSize="8.5" fill="#6da7ec" transform={`rotate(-90 ${SVG_W - 18} ${y0 + fh / 2})`}>{Math.round(frame.hMm)} mm</text>

        {/* overflow bar above the frame */}
        {overflowU > 0 && (
          <g>
            <rect x={Math.min(bayX, SVG_W / 2 - 90)} y={40} width={Math.max(bayW, 180)} height={16} fill="rgba(208,59,59,0.25)" stroke="#d03b3b" strokeDasharray="4 3" />
            <text x={SVG_W / 2} y={51} textAnchor="middle" fontSize="9" fill="#ff8a8a" fontWeight={600}>{t('catalog.bp.overflow', { n: overflowU, unit: frame.unit })}</text>
          </g>
        )}

        {/* zero-U zones: EIA side channels for vertical PDUs; OCP rear busbar (drawn beside the frame) */}
        {open ? (
          <g>
            <rect x={x0 + fw + 36} y={stackTop} width={10} height={stackBottom - stackTop} fill="none" stroke="#199e70" strokeDasharray="3 3" />
            <text x={x0 + fw + 41} y={stackTop + (stackBottom - stackTop) / 2} textAnchor="middle" fontSize="8" fill="#5cc49b" transform={`rotate(-90 ${x0 + fw + 41} ${stackTop + (stackBottom - stackTop) / 2})`}>{zeroULabel}</text>
          </g>
        ) : (
          [x0 - 34, x0 + fw + 24].map((zx, i) => (
            <g key={i}>
              <rect x={zx} y={stackTop} width={10} height={stackBottom - stackTop} fill="none" stroke="#199e70" strokeDasharray="3 3" />
              <text x={zx + 5} y={stackTop + (stackBottom - stackTop) / 2} textAnchor="middle" fontSize="8" fill="#5cc49b" transform={`rotate(-90 ${zx + 5} ${stackTop + (stackBottom - stackTop) / 2})`}>{`${zeroULabel} ${i ? 'B' : 'A'}`}</text>
            </g>
          ))
        )}

        {/* frame, caps, posts */}
        <rect x={x0} y={y0} width={fw} height={fh} fill="#14171b" stroke="#b3b8bf" strokeWidth="1.4" />
        <rect x={x0} y={y0} width={fw} height={capMm * s} fill="#23282f" />
        <rect x={x0} y={stackBottom} width={fw} height={y0 + fh - stackBottom} fill="#23282f" />
        <text x={x0 + fw / 2} y={y0 + (capMm * s) / 2 + 3} textAnchor="middle" fontSize="7.5" fill="#858b93">{t('catalog.bp.topCap')}</text>
        <text x={x0 + fw / 2} y={stackBottom + (y0 + fh - stackBottom) / 2 + 3} textAnchor="middle" fontSize="7.5" fill="#858b93">{t('catalog.bp.base')}</text>
        <rect x={x0} y={stackTop} width={bayX - x0} height={stackBottom - stackTop} fill="#3a4048" />
        <rect x={bayX + bayW} y={stackTop} width={x0 + fw - bayX - bayW} height={stackBottom - stackTop} fill="#3a4048" />
        {/* rails (mounting hole column) */}
        {[bayX - 2.5, bayX + bayW + 0.5].map((rx, i) => <rect key={i} x={rx} y={stackTop} width={2} height={stackBottom - stackTop} fill="#6b7280" />)}

        {/* U ruler on both sides: tick every U, major tick + bold label each 5 U */}
        {Array.from({ length: frame.ru }, (_, i) => i + 1).map((u) => {
          const yc = yOfU(u) - pu / 2;
          const major = u % 5 === 0 || u === 1;
          const tl = major ? 9 : 4;
          return (
            <g key={u}>
              <line x1={x0 - tl} y1={yOfU(u)} x2={x0} y2={yOfU(u)} stroke={major ? '#b3b8bf' : '#4a5058'} strokeWidth={major ? 0.9 : 0.6} />
              <line x1={x0 + fw} y1={yOfU(u)} x2={x0 + fw + tl} y2={yOfU(u)} stroke={major ? '#b3b8bf' : '#4a5058'} strokeWidth={major ? 0.9 : 0.6} />
              <text x={x0 - (open ? 12 : 11)} y={yc + 2.4} textAnchor="end" fontSize={major ? 7.5 : 6.2} fontWeight={major ? 700 : 400} fill={major ? '#f2f3f4' : '#858b93'}>{u}</text>
              <text x={x0 + fw + (open ? 12 : 11)} y={yc + 2.4} textAnchor="start" fontSize={major ? 7.5 : 6.2} fontWeight={major ? 700 : 400} fill={major ? '#f2f3f4' : '#858b93'}>{u}</text>
            </g>
          );
        })}
        <line x1={x0} y1={stackTop} x2={x0 + fw} y2={stackTop} stroke="#4a5058" strokeWidth="0.6" />

        {/* blank plates */}
        {blanks.map((u) => (
          <rect key={`bl${u}`} x={bayX} y={yOfU(u) - pu + 0.4} width={bayW} height={pu - 0.8} fill="url(#bp-blank)" stroke="#2a2f36" strokeWidth="0.5" />
        ))}

        {/* components */}
        {entries.map((e, i) => {
          const u0 = clampU(e.u);
          const u1 = clampU(e.u + e.heightU - 1);
          const yTop = yOfU(u1) - pu;
          const h = (u1 - u0 + 1) * pu;
          const bad = !!e.conflict || e.u < 1 || e.u + e.heightU - 1 > frame.ru;
          const isSel = selected && e.id === selected.id;
          const label = e.label.length > Math.floor(bayW / 4.6) ? `${e.label.slice(0, Math.max(4, Math.floor(bayW / 4.6) - 1))}…` : e.label;
          return (
            <g
              key={e.id ?? i}
              data-bp-entry={e.id}
              style={{ cursor: props.onSelect ? 'pointer' : 'default' }}
              onMouseMove={(ev) => {
                const r = (ev.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                setHover({ e, x: ev.clientX - r.left, y: ev.clientY - r.top });
              }}
              onMouseLeave={() => setHover(null)}
              onClick={(ev) => { ev.stopPropagation(); if (e.id) props.onSelect?.(e.id); }}
            >
              <rect x={bayX + 0.5} y={yTop + 0.5} width={bayW - 1} height={Math.max(1, h - 1)} rx={1.5} fill={colorOf(e.kind)} fillOpacity={bad ? 0.35 : 0.88} stroke={bad ? '#ff4d4d' : isSel ? '#ffffff' : 'rgba(0,0,0,0.45)'} strokeWidth={bad ? 1.8 : isSel ? 1.6 : 0.6} />
              {h >= 8 && (
                <text x={bayX + 6} y={yTop + h / 2 + 3} fontSize={h >= 14 ? 8.5 : 7} fill={bad ? '#ffd0d0' : '#ffffff'} pointerEvents="none">{label}</text>
              )}
              {h >= 8 && (
                <text x={bayX + bayW - 5} y={yTop + h / 2 + 3} fontSize={7} textAnchor="end" fill="rgba(255,255,255,0.75)" pointerEvents="none">{`${e.heightU}${frame.unit}`}</text>
              )}
            </g>
          );
        })}

        {/* bottom line: depth + legend */}
        <text x={SVG_W / 2} y={SVG_H - 26} textAnchor="middle" fontSize="9" fill="#b3b8bf">{t('catalog.bp.footer', { d: Math.round(frame.dMm), used: entries.filter((e) => e.u >= 1).reduce((a, e) => a + e.heightU, 0), ru: frame.ru, unit: frame.unit, blank: blanks.length })}</text>
        {(['node', 'switch', 'power-shelf', 'mgmt', 'blank'] as const).map((k, i) => (
          <g key={k} transform={`translate(${SVG_W / 2 - 170 + i * 72}, ${SVG_H - 14})`}>
            <rect x={0} y={-7} width={9} height={9} fill={k === 'blank' ? 'url(#bp-blank)' : colorOf(k)} stroke="#4a5058" strokeWidth="0.5" />
            <text x={13} y={1} fontSize="8" fill="#858b93">{t(`catalog.bp.kind.${k}`)}</text>
          </g>
        ))}
        {badCount > 0 && <text x={SVG_W / 2} y={SVG_H - 40} textAnchor="middle" fontSize="9" fill="#ff8a8a" fontWeight={600}>{t('catalog.bp.conflicts', { n: badCount })}</text>}
      </svg>

      {/* move controls for the selected block */}
      {selected && props.onMove && selected.id && (
        <div style={{ position: 'absolute', left: bayX + bayW + 40, top: Math.max(4, yOfU(clampU(selected.u + selected.heightU - 1)) - pu - 4), display: 'flex', flexDirection: 'column', gap: 2 }}>
          <button className="btn sm" data-bp-move="up" title={t('catalog.bp.moveUp')} onClick={() => props.onMove!(selected.id!, 1)} style={{ padding: '0 6px', lineHeight: '16px' }}>▲</button>
          <button className="btn sm" data-bp-move="down" title={t('catalog.bp.moveDown')} onClick={() => props.onMove!(selected.id!, -1)} style={{ padding: '0 6px', lineHeight: '16px' }}>▼</button>
        </div>
      )}

      {hover && (
        <div className="glass" role="tooltip" style={{ position: 'absolute', left: Math.min(hover.x + 14, SVG_W - 210), top: Math.min(hover.y + 12, SVG_H - 90), width: 200, padding: '6px 8px', fontSize: 11.5, pointerEvents: 'none', zIndex: 3 }}>
          <div style={{ fontWeight: 600 }}>{hover.e.label}</div>
          <div className="secondary">{t(`catalog.bp.kind.${hover.e.kind ?? 'other'}`)} · U{hover.e.u}{hover.e.heightU > 1 ? `–U${hover.e.u + hover.e.heightU - 1}` : ''} · {hover.e.heightU} {frame.unit}</div>
          <div className="secondary">{hover.e.kw != null ? `${hover.e.kw.toFixed(1)} kW` : t('catalog.bp.kwUnknown')}{hover.e.catalogId ? ` · ${hover.e.catalogId}` : ''}</div>
          {hover.e.conflict && <div style={{ color: 'var(--critical)' }}>{t(`catalog.bp.conflict.${hover.e.conflict}`)}</div>}
        </div>
      )}
      {props.issues && props.issues.length > 0 && (
        <div style={{ position: 'absolute', left: 8, right: 8, bottom: 52, display: 'flex', flexDirection: 'column', gap: 2, pointerEvents: 'none' }}>
          {props.issues.slice(0, 4).map((m, i) => <div key={i} className="status error" style={{ background: 'rgba(40,10,10,0.9)', padding: '2px 6px', borderRadius: 4, fontSize: 11 }}>{m}</div>)}
        </div>
      )}
    </div>
  );
}

/** Rack model options for selects (fixed frames the blueprint supports). */
export const BLUEPRINT_RACK_MODELS = RACK_MODELS;
