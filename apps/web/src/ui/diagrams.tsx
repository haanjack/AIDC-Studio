import { useMemo, useState, type ReactElement } from 'react';
import type { FabricAnalysis, OneLineNode, PowerAnalysis, ScheduleAnalysis, ScheduleTask, TrafficReport } from '@aidc/core';
import { SERIES, useWidth } from './charts.tsx';
import { DataTable, StatusLabel } from './controls.tsx';
import { fmtDate, fmtPower } from '../app/format.ts';
import { useT } from '../i18n/index.ts';

// ───────────────────────── One-line diagram ─────────────────────────

/** Scenario state painted on a one-line node border (T3 power plane). */
export type OneLineNodeState = 'warn' | 'over' | 'failed';
const NODE_STATE_STROKE: Record<OneLineNodeState, string> = { warn: 'var(--warning)', over: 'var(--critical)', failed: 'var(--text-muted)' };

/**
 * Layered top-down one-line diagram from PowerAnalysis.oneLine (longest-path layering).
 * Nodes with `refs` (busway runs / racks) are clickable (↗) for one-line ↔ 3D linking; `nodeStates` colours node borders.
 */
export function OneLineDiagram({ oneLine, onNodeClick, nodeStates }: { oneLine: PowerAnalysis['oneLine']; onNodeClick?: (n: OneLineNode) => void; nodeStates?: Record<string, OneLineNodeState> }) {
  const tr = useT();
  const kindLabel = (k: OneLineNode['kind']) => tr(`power.oneline.kind.${k}`);
  const [hover, setHover] = useState<string | null>(null);
  const layout = useMemo(() => {
    const nodes = oneLine.nodes;
    const incoming = new Map<string, string[]>();
    nodes.forEach((n) => incoming.set(n.id, []));
    oneLine.edges.forEach((e) => incoming.get(e.to)?.push(e.from));
    const layer = new Map<string, number>();
    const visit = (id: string, stack: Set<string>): number => {
      if (layer.has(id)) return layer.get(id)!;
      if (stack.has(id)) return 0;
      stack.add(id);
      const parents = incoming.get(id) ?? [];
      const l = parents.length ? Math.max(...parents.map((p) => visit(p, stack))) + 1 : 0;
      stack.delete(id);
      layer.set(id, l);
      return l;
    };
    nodes.forEach((n) => visit(n.id, new Set()));
    // source-only helpers (batteries) sit directly above the equipment they feed, not on the top row
    nodes.forEach((n) => {
      if (n.kind !== 'battery' || (incoming.get(n.id) ?? []).length) return;
      const children = oneLine.edges.filter((e) => e.from === n.id).map((e) => layer.get(e.to) ?? 1);
      if (children.length) layer.set(n.id, Math.max(0, Math.min(...children) - 1));
    });
    const layers: OneLineNode[][] = [];
    nodes.forEach((n) => {
      const l = layer.get(n.id) ?? 0;
      (layers[l] ??= []).push(n);
    });
    // order within layer by path then by parent position
    const posX = new Map<string, number>();
    const NODE_W = 132;
    const GAP = 16;
    const ROW_H = 92;
    let maxW = 0;
    layers.forEach((row, li) => {
      if (li > 0) {
        row.sort((a, b) => {
          const pa = (incoming.get(a.id) ?? []).map((p) => posX.get(p) ?? 0);
          const pb = (incoming.get(b.id) ?? []).map((p) => posX.get(p) ?? 0);
          const ma = pa.length ? pa.reduce((s, v) => s + v, 0) / pa.length : 0;
          const mb = pb.length ? pb.reduce((s, v) => s + v, 0) / pb.length : 0;
          return ma - mb || (a.path ?? '').localeCompare(b.path ?? '');
        });
      }
      row.forEach((n, i) => posX.set(n.id, i * (NODE_W + GAP)));
      maxW = Math.max(maxW, row.length * (NODE_W + GAP));
    });
    // center each layer
    layers.forEach((row) => {
      const w = row.length * (NODE_W + GAP);
      const off = (maxW - w) / 2;
      row.forEach((n) => posX.set(n.id, (posX.get(n.id) ?? 0) + off));
    });
    return { layers, posX, NODE_W, ROW_H, width: Math.max(maxW, 400), height: layers.length * ROW_H + 10 };
  }, [oneLine]);

  // A / B match the 3D power overlay (series 1 / 3); C reserve = series 7
  const pathColor = (p?: string) => (p === 'A' ? SERIES[0] : p === 'B' ? SERIES[2] : p === 'C' ? SERIES[6] : 'var(--axis)');
  const nodeY = (id: string) => {
    const li = layout.layers.findIndex((row) => row.some((n) => n.id === id));
    return li * layout.ROW_H + 6;
  };
  const byId = new Map(oneLine.nodes.map((n) => [n.id, n]));
  const hasPaths = oneLine.nodes.some((n) => n.path);

  return (
    <div>
      {hasPaths && (
        <div className="legend">
          <span className="item"><span className="ln" style={{ background: SERIES[0] }} />{tr('power.oneline.legend.A')}</span>
          <span className="item"><span className="ln" style={{ background: SERIES[2] }} />{tr('power.oneline.legend.B')}</span>
          <span className="item"><span className="ln" style={{ background: SERIES[6] }} />{tr('power.oneline.legend.C')}</span>
          <span className="item"><span className="ln" style={{ background: 'var(--axis)' }} />{tr('power.oneline.legend.common')}</span>
          {nodeStates && Object.keys(nodeStates).length > 0 && (
            <>
              <span className="item"><span className="sw" style={{ background: 'var(--warning)' }} />{tr('power.oneline.legend.warn')}</span>
              <span className="item"><span className="sw" style={{ background: 'var(--critical)' }} />{tr('power.oneline.legend.over')}</span>
            </>
          )}
        </div>
      )}
      <div style={{ overflowX: 'auto' }}>
        <svg width={layout.width} height={layout.height} role="img" aria-label={tr('power.oneline.aria')}>
          {oneLine.edges.map((e, i) => {
            const from = byId.get(e.from);
            const to = byId.get(e.to);
            if (!from || !to) return null;
            const x1 = (layout.posX.get(e.from) ?? 0) + layout.NODE_W / 2;
            const y1 = nodeY(e.from) + 46;
            const x2 = (layout.posX.get(e.to) ?? 0) + layout.NODE_W / 2;
            const y2 = nodeY(e.to);
            const my = (y1 + y2) / 2;
            const active = hover === e.from || hover === e.to;
            return (
              <path key={i} d={`M${x1},${y1}V${my}H${x2}V${y2}`} fill="none"
                style={{ stroke: pathColor(to.path ?? from.path), strokeWidth: active ? 2.5 : 1.5, opacity: hover && !active ? 0.35 : 1 }} />
            );
          })}
          {layout.layers.flat().map((n) => {
            const x = layout.posX.get(n.id) ?? 0;
            const y = nodeY(n.id);
            const linked = !!onNodeClick && !!n.refs?.length;
            const state = nodeStates?.[n.id];
            return (
              <g key={n.id} transform={`translate(${x},${y})`} onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)}
                onClick={linked ? () => onNodeClick!(n) : undefined} style={{ cursor: linked ? 'pointer' : undefined }} data-oneline-node={n.id}>
                <rect width={layout.NODE_W} height={46} rx={6}
                  style={{ fill: 'var(--surface-2)', stroke: hover === n.id ? 'var(--accent)' : state ? NODE_STATE_STROKE[state] : 'var(--border-strong)', strokeWidth: state ? 2 : 1, strokeDasharray: state === 'failed' ? '4 3' : undefined }} />
                <rect width={3} height={46} rx={1.5} style={{ fill: pathColor(n.path) }} />
                <text x={10} y={15} style={{ fill: 'var(--text-muted)', fontSize: 10 }}>{kindLabel(n.kind)}{n.path ? ` · ${n.path}` : ''}</text>
                {linked && <text x={layout.NODE_W - 8} y={15} textAnchor="end" style={{ fill: 'var(--accent)', fontSize: 11 }}>↗</text>}
                <text x={10} y={29} style={{ fill: 'var(--text-primary)', fontSize: 11.5 }}>{n.label.length > 19 ? `${n.label.slice(0, 18)}…` : n.label}</text>
                <text x={10} y={41} style={{ fill: 'var(--text-secondary)', fontSize: 10.5 }}>
                  {[n.ratingKVA ? `${Math.round(n.ratingKVA).toLocaleString()} kVA` : '', n.loadKW ? fmtPower(n.loadKW) : ''].filter(Boolean).join(' · ')}
                </text>
                <title>{`${n.label}\n${kindLabel(n.kind)}${n.ratingKVA ? `\n${tr('power.oneline.rating', { v: n.ratingKVA })}` : ''}${n.loadKW ? `\n${tr('power.oneline.load', { v: fmtPower(n.loadKW) })}` : ''}${linked ? `\n${tr('power.oneline.linked', { n: n.refs!.length })}` : ''}`}</title>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

// ───────────────────────── Workload traffic bottleneck ─────────────────────────

type TrafficTier = TrafficReport['perTier'][number];
type TrafficState = 'idle' | 'good' | 'warning' | 'error';

const trafficState = (tier: TrafficTier): TrafficState => {
  if (tier.bytesPerStepGB <= 0 || tier.utilization <= 0) return 'idle';
  if (tier.utilization > 1) return 'error';
  if (tier.headroom < 0.2) return 'warning';
  return 'good';
};

const trafficColor = (state: TrafficState) =>
  state === 'error' ? 'var(--critical)' : state === 'warning' ? 'var(--warning)' : state === 'good' ? 'var(--good)' : 'var(--text-muted)';

/** Keep extreme offered-demand overruns legible inside a small SVG node. */
const trafficPct = (value: number) => {
  const percent = value * 100;
  if (percent >= 1_000_000) return `${(percent / 1_000_000).toFixed(1)}M %`;
  if (percent >= 10_000) return `${(percent / 1_000).toFixed(1)}k %`;
  return `${percent.toLocaleString(undefined, { maximumFractionDigits: value < 0.1 ? 1 : 0 })} %`;
};

/**
 * Workload traffic laid over the calculated fabric path. This deliberately visualises the analytical tier result rather than
 * pretending that balanced rail / ECMP traffic is measured per physical port. The caption in NetworkPanel states that boundary.
 */
export function TrafficBottleneckMap({ traffic, workloadName }: { traffic: TrafficReport; workloadName: string }) {
  const tr = useT();
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<string | null>(null);
  const tiers = traffic.perTier;
  const active = tiers.filter((tier) => tier.bytesPerStepGB > 0 && tier.utilization > 0);
  const bottleneck = active.reduce<TrafficTier | undefined>((worst, tier) => (!worst || tier.utilization > worst.utilization ? tier : worst), undefined);
  const state = bottleneck ? trafficState(bottleneck) : 'idle';
  const fullTierLabel = (tier: TrafficTier['tier']) => tier === 'scale-up' && traffic.physical?.scaleUpName
    ? tr('network.tier.scale-upNamed', { name: traffic.physical.scaleUpName })
    : tr(`network.tier.${tier}`);
  const nodeTierLabel = (tier: TrafficTier['tier']) => tier === 'scale-up' && traffic.physical?.scaleUpName
    ? traffic.physical.scaleUpName
    : tr(`network.traffic.pathTier.${tier}`);
  const tierName = bottleneck ? fullTierLabel(bottleneck.tier) : '';
  const rateMode = traffic.mode === 'inference' || traffic.mode === 'aggregate';
  const aggregateMode = traffic.mode === 'aggregate';
  const scaleUpName = traffic.physical?.scaleUpName ?? tr('network.tier.scale-up');
  const scaleOutName = traffic.physical?.scaleOutFabric
    ? tr(`network.fabricName.${traffic.physical.scaleOutFabric}`)
    : tr('network.traffic.pathScaleOutUnknown');
  const summary = !bottleneck
    ? tr('network.traffic.pathIdle')
    : state === 'error'
      ? tr(rateMode ? 'network.traffic.pathOverInference' : 'network.traffic.pathOver', { tier: tierName, util: trafficPct(bottleneck.utilization) })
      : state === 'warning'
        ? tr(rateMode ? 'network.traffic.pathTightInference' : 'network.traffic.pathTight', { tier: tierName, util: trafficPct(bottleneck.utilization), headroom: trafficPct(Math.max(0, bottleneck.headroom)) })
        : tr('network.traffic.pathHealthy', { tier: tierName, util: trafficPct(bottleneck.utilization), headroom: trafficPct(Math.max(0, bottleneck.headroom)) });

  const nodeH = 120;
  const compactLayout = width < 700;
  const gap = compactLayout ? 18 : 32;
  const targetWidth = Math.max(440, width);
  // These cards contain full endpoint-rate labels; prefer readable content width and use horizontal scrolling below it.
  // A small upper bound avoids turning a 3-tier path into three empty, screen-wide rectangles on ultrawide displays.
  const nodeMinW = rateMode ? 228 : 164;
  const nodePreferredW = rateMode ? 248 : 184;
  const nodeW = Math.max(nodeMinW, Math.min(nodePreferredW, (targetWidth - 32 - Math.max(0, tiers.length - 1) * gap) / Math.max(1, tiers.length)));
  const compactNode = nodeW < 120;
  const minWidth = tiers.length * nodeW + Math.max(0, tiers.length - 1) * gap + 32;
  const svgWidth = Math.max(width, minWidth);
  const span = tiers.length * nodeW + Math.max(0, tiers.length - 1) * gap;
  const startX = Math.max(16, (svgWidth - span) / 2);
  const nodeY = 52;
  const midY = nodeY + nodeH / 2;
  const groupBytes = traffic.bytesPerStepByGroup;
  const groups = (['tp', 'cp', 'pp', 'dp', 'ep', 'pd'] as const).filter((group) => (groupBytes[group] ?? 0) > 0);
  const bytesKey = aggregateMode ? 'network.traffic.pathBytesAggregate' : rateMode ? 'network.traffic.pathBytesInference' : 'network.traffic.pathBytes';
  const capacityKey = aggregateMode ? 'network.traffic.pathCapacityAggregate' : 'network.traffic.pathCapacity';
  const capacityShortKey = aggregateMode ? 'network.traffic.pathCapacityShortAggregate' : 'network.traffic.pathCapacityShort';
  const routeLabel = (route: string) => route === '-'
    ? '—'
    : route.split('+').map((tier) => fullTierLabel(tier as TrafficTier['tier'])).join(' → ');

  return (
    <div data-traffic-bottleneck data-bottleneck-tier={bottleneck?.tier ?? 'none'} data-bottleneck-state={state}>
      <div className="row wrap" style={{ marginBottom: 6 }}>
        <StatusLabel severity={state === 'error' ? 'error' : state === 'warning' ? 'warning' : state === 'idle' ? 'info' : 'good'}>{summary}</StatusLabel>
        <span className="grow" />
        <span className="hint"><strong>{tr('network.traffic.pathWorkload')}:</strong> {workloadName}</span>
      </div>
      <div ref={ref} style={{ overflowX: 'auto' }}>
        <svg width={svgWidth} height={184} role="img" aria-label={tr('network.traffic.pathAria', { workload: workloadName, summary })}>
          <text x={startX} y={13} style={{ fill: 'var(--text-secondary)', fontSize: 10.5, fontWeight: 700 }}>{tr('network.traffic.pathScaleUpHeader', { fabric: scaleUpName })}</text>
          {tiers.length > 1 && (
            <>
              <line x1={startX + nodeW + gap / 2} x2={startX + nodeW + gap / 2} y1={4} y2={nodeY + nodeH} style={{ stroke: 'var(--border)', strokeWidth: 1, strokeDasharray: '4 4' }} />
              <text x={startX + nodeW + gap} y={13} style={{ fill: 'var(--text-secondary)', fontSize: 10.5, fontWeight: 700 }}>{tr('network.traffic.pathScaleOutHeader', { fabric: scaleOutName })}</text>
            </>
          )}
          {tiers.slice(0, -1).map((tier, i) => {
            const next = tiers[i + 1];
            // Scale-up and scale-out are distinct fabrics, not consecutive hops of one packet path.
            if (tier.tier === 'scale-up') return null;
            const x1 = startX + i * (nodeW + gap) + nodeW;
            const x2 = startX + (i + 1) * (nodeW + gap);
            const nextState = trafficState(next);
            const color = trafficColor(nextState);
            const lineW = nextState === 'idle' ? 1.5 : 2 + Math.min(6, next.utilization * 6);
            return (
              <g key={`${tier.tier}-${next.tier}`} style={{ opacity: hover && hover !== tier.tier && hover !== next.tier ? 0.28 : 1 }}>
                <line x1={x1 + 4} x2={x2 - 8} y1={midY} y2={midY} style={{ stroke: color, strokeWidth: lineW }} />
                <path d={`M${x2 - 8},${midY - 6}L${x2},${midY}L${x2 - 8},${midY + 6}Z`} style={{ fill: color }} />
              </g>
            );
          })}
          {tiers.map((tier, i) => {
            const x = startX + i * (nodeW + gap);
            const tierState = trafficState(tier);
            const color = trafficColor(tierState);
            const selected = bottleneck?.tier === tier.tier;
            const faded = hover !== null && hover !== tier.tier;
            const barW = Math.max(0, (nodeW - 2) * Math.min(1, tier.utilization));
            const avg = tier.utilizationAvg ?? 0;
            return (
              <g key={tier.tier} transform={`translate(${x},${nodeY})`} data-traffic-tier={tier.tier}
                data-utilization={tier.utilization} onMouseEnter={() => setHover(tier.tier)} onMouseLeave={() => setHover(null)}
                style={{ opacity: faded ? 0.42 : 1 }}>
                {selected && (
                  <g transform="translate(0,-26)">
                    <rect width={nodeW} height={20} rx={10} style={{ fill: color, opacity: 0.18 }} />
                    <text x={nodeW / 2} y={14} textAnchor="middle" style={{ fill: color, fontSize: 10.5, fontWeight: 700, letterSpacing: '.04em' }}>{tr('network.traffic.pathBottleneck')}</text>
                  </g>
                )}
                <rect width={nodeW} height={nodeH} rx={7} style={{ fill: 'var(--surface-2)', stroke: color, strokeWidth: selected ? 2.5 : 1.25 }} />
                <rect x={1} y={nodeH - 7} width={nodeW - 2} height={6} rx={3} style={{ fill: 'var(--surface-3)' }} />
                <rect x={1} y={nodeH - 7} width={barW} height={6} rx={3} style={{ fill: color }} />
                <text x={9} y={19} style={{ fill: 'var(--text-secondary)', fontSize: compactNode ? 9.5 : 11, fontWeight: 600 }}>{nodeTierLabel(tier.tier)}</text>
                <text x={9} y={48} style={{ fill: color, fontSize: compactNode ? 19 : 22, fontWeight: 700 }}>{trafficPct(tier.utilization)}</text>
                <text x={9} y={65} style={{ fill: 'var(--text-muted)', fontSize: compactNode ? 9 : 10.5 }}>{tierState === 'idle' ? tr('network.traffic.pathNotTraversed') : <>{tr(rateMode ? 'network.traffic.pathSteady' : 'network.traffic.pathBurst')} · {tr('network.traffic.pathAverage')} {trafficPct(avg)}</>}</text>
                <text x={9} y={84} style={{ fill: 'var(--text-secondary)', fontSize: compactNode ? 9 : 10.5 }}>{tr(bytesKey, { value: tier.bytesPerStepGB.toFixed(1) })}</text>
                <text x={9} y={100} style={{ fill: 'var(--text-secondary)', fontSize: compactNode ? 9 : 10.5 }}>{tr(aggregateMode ? capacityShortKey : tier.tier === 'scale-up' ? 'network.traffic.pathCapacityShortScaleUp' : 'network.traffic.pathCapacityShortEndpoint', { value: Math.round(tier.capacityGBps ?? 0).toLocaleString() })}</text>
                <title>{`${fullTierLabel(tier.tier)}\n${tr(rateMode ? 'network.traffic.pathSteady' : 'network.traffic.pathBurst')}: ${trafficPct(tier.utilization)}\n${tr('network.traffic.pathAverage')}: ${trafficPct(avg)}\n${tr(bytesKey, { value: tier.bytesPerStepGB.toFixed(2) })}\n${tr(capacityKey, { value: (tier.capacityGBps ?? 0).toFixed(1) })}`}</title>
              </g>
            );
          })}
        </svg>
      </div>
      <p className="caption" style={{ margin: '0 0 4px' }}>{tr('network.traffic.pathFabricSeparation')}</p>
      <p className="caption" style={{ margin: '0 0 4px' }}>{tr(aggregateMode ? 'network.traffic.pathScopeAggregate' : rateMode ? 'network.traffic.pathScopeInference' : 'network.traffic.pathScopeTraining')}</p>
      {groups.length > 0 && (
        <div className="row wrap" style={{ gap: 6, marginTop: 2 }} aria-label={tr('network.traffic.pathCollectives')}>
          <span className="hint">{tr('network.traffic.pathCollectives')}:</span>
          {groups.map((group) => (
            <span key={group} className="badge" title={tr(`network.traffic.group.${group}`)}>
              {group.toUpperCase()} · {routeLabel(traffic.groupTier?.[group] ?? '-')}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ───────────────────────── Fabric topology ─────────────────────────

export function FabricTopology({ fabric, endpointLabel = 'GPU/NIC' }: { fabric: FabricAnalysis; endpointLabel?: string }) {
  const tr = useT();
  const [ref, width] = useWidth<HTMLDivElement>();
  const tiers = [...fabric.tiers].reverse(); // top: core/spine
  const rows = [...tiers.map((t) => ({ name: t.name, count: t.switches, ports: t.portsPerSwitch, down: t.downlinks, up: t.uplinks })), { name: endpointLabel, count: fabric.endpoints, ports: 0, down: 0, up: 0 }];
  const rowH = 74;
  const height = rows.length * rowH + 8;
  const maxBoxes = Math.max(4, Math.floor((width - 40) / 34));
  const boxW = 24;

  const positions = rows.map((r) => {
    const n = Math.min(r.count, maxBoxes);
    const span = Math.min(width - 60, n * 34);
    const start = (width - span) / 2;
    return Array.from({ length: n }, (_, i) => start + (n === 1 ? span / 2 : (i * span) / Math.max(1, n - 1)));
  });

  return (
    <div ref={ref}>
      <svg width={width} height={height} role="img" aria-label={tr('ui.diagram.topologyAria')}>
        {rows.slice(0, -1).map((_, ri) => {
          const top = positions[ri];
          const bot = positions[ri + 1];
          const lines: ReactElement[] = [];
          const step = Math.max(1, Math.floor((top.length * bot.length) / 260));
          let k = 0;
          top.forEach((tx, i) =>
            bot.forEach((bx, j) => {
              if ((i * 7 + j * 3) % step !== 0) return;
              lines.push(<line key={`${i}-${j}`} x1={tx + boxW / 2} y1={ri * rowH + 34} x2={bx + boxW / 2} y2={(ri + 1) * rowH + 14} style={{ stroke: SERIES[ri % 3], strokeWidth: 1, opacity: 0.22 }} />);
              k++;
            }),
          );
          return <g key={ri}>{lines}</g>;
        })}
        {rows.map((r, ri) => (
          <g key={r.name}>
            <text x={4} y={ri * rowH + 14} style={{ fill: 'var(--text-secondary)', fontSize: 11.5 }}>{r.name}</text>
            <text x={4} y={ri * rowH + 28} style={{ fill: 'var(--text-muted)', fontSize: 10.5 }}>
              {r.count.toLocaleString()}{ri < rows.length - 1 ? ` × ${r.ports}p (↓${r.down} ↑${r.up})` : ` ${tr('ui.diagram.ports')}`}
            </text>
            {positions[ri].map((x, i) => (
              <rect key={i} x={x} y={ri * rowH + 14} width={boxW} height={ri < rows.length - 1 ? 20 : 14} rx={3}
                style={{ fill: ri < rows.length - 1 ? 'var(--surface-3)' : SERIES[0], stroke: ri < rows.length - 1 ? SERIES[ri % 3] : 'none', strokeWidth: 1 }} />
            ))}
            {r.count > positions[ri].length && (
              <text x={width - 4} y={ri * rowH + 50} textAnchor="end" style={{ fill: 'var(--text-muted)', fontSize: 10.5 }}>
                {tr('ui.diagram.shownOf', { shown: positions[ri].length, total: r.count.toLocaleString() })}
              </text>
            )}
          </g>
        ))}
      </svg>
    </div>
  );
}

// ───────────────────────── Gantt ─────────────────────────

const PHASES: ScheduleTask['phase'][] = ['procurement', 'site', 'power', 'cooling', 'it', 'network', 'commissioning', 'handover'];
/** i18n keys of the schedule phases (namespace 'ui'). */
export const PHASE_LABEL_KEY: Record<ScheduleTask['phase'], string> = {
  procurement: 'ui.gantt.phase.procurement', site: 'ui.gantt.phase.site', power: 'ui.gantt.phase.power', cooling: 'ui.gantt.phase.cooling', it: 'ui.gantt.phase.it', network: 'ui.gantt.phase.network', commissioning: 'ui.gantt.phase.commissioning', handover: 'ui.gantt.phase.handover',
};

export function Gantt({ schedule }: { schedule: ScheduleAnalysis }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ t: ScheduleTask; x: number; y: number } | null>(null);
  const [showTable, setShowTable] = useState(false);
  const tr = useT();
  const phaseLabel = (p: ScheduleTask['phase']) => tr(PHASE_LABEL_KEY[p]);
  const tasks = useMemo(
    () => [...schedule.tasks].sort((a, b) => PHASES.indexOf(a.phase) - PHASES.indexOf(b.phase) || a.start.localeCompare(b.start)),
    [schedule.tasks],
  );
  if (!tasks.length) return <div className="empty">{tr('ui.gantt.empty')}</div>;
  const t0 = Math.min(...tasks.map((t) => Date.parse(t.start)));
  const t1 = Math.max(...tasks.map((t) => Date.parse(t.end)), ...schedule.milestones.map((m) => Date.parse(m.date)));
  const labelW = 230;
  const plotW = Math.max(200, width - labelW - 16);
  const rowH = 20;
  const top = 34;
  const sx = (ms: number) => labelW + ((ms - t0) / Math.max(1, t1 - t0)) * plotW;
  const height = top + tasks.length * rowH + 30;
  const months: number[] = [];
  const d = new Date(t0);
  d.setUTCDate(1);
  while (d.getTime() <= t1) {
    months.push(d.getTime());
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  const monthStep = Math.max(1, Math.ceil(months.length / Math.max(1, Math.floor(plotW / 56))));
  const colorOf = (p: ScheduleTask['phase']) => SERIES[PHASES.indexOf(p) % SERIES.length];

  return (
    <div className="chart">
      <div className="row">
        <div className="legend" style={{ margin: 0 }}>
          {PHASES.filter((p) => tasks.some((t) => t.phase === p)).map((p) => (
            <span key={p} className="item"><span className="sw" style={{ background: colorOf(p) }} />{phaseLabel(p)}</span>
          ))}
          <span className="item"><span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>◆</span>{tr('ui.gantt.criticalPath')}</span>
        </div>
        <span className="grow" />
        <button className="btn ghost sm" onClick={() => setShowTable((v) => !v)}>{showTable ? tr('ui.chart.showChart') : tr('ui.chart.showTable')}</button>
      </div>
      {showTable ? (
        <DataTable
          columns={[
            { key: 'n', header: tr('ui.gantt.col.task'), render: (t: ScheduleTask) => `${t.critical ? '◆ ' : ''}${t.name}` },
            { key: 'p', header: tr('ui.gantt.col.phase'), render: (t) => phaseLabel(t.phase) },
            { key: 's', header: tr('ui.gantt.col.start'), render: (t) => fmtDate(t.start), sortValue: (t) => t.start },
            { key: 'e', header: tr('ui.gantt.col.end'), render: (t) => fmtDate(t.end), sortValue: (t) => t.end },
            { key: 'd', header: tr('ui.gantt.col.days'), num: true, render: (t) => t.durationDays.toFixed(0), sortValue: (t) => t.durationDays },
          ]}
          rows={tasks}
          rowKey={(t) => t.id}
          maxHeight={520}
        />
      ) : (
        <div ref={ref} style={{ position: 'relative' }} onMouseLeave={() => setHover(null)}>
          <svg width={width} height={height}>
            {months.map((m, i) =>
              i % monthStep === 0 ? (
                <g key={m}>
                  <line className="gridline" x1={sx(m)} x2={sx(m)} y1={top - 6} y2={height - 24} />
                  <text className="tick" x={sx(m) + 3} y={top - 12}>{new Date(m).toISOString().slice(2, 7).replace('-', '.')}</text>
                </g>
              ) : null,
            )}
            {tasks.map((t, i) => {
              const y = top + i * rowH;
              const x1 = sx(Date.parse(t.start));
              const x2 = Math.max(x1 + 3, sx(Date.parse(t.end)));
              return (
                <g key={t.id}
                  onMouseMove={(e) => {
                    const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                    setHover({ t, x: e.clientX - rect.left, y: e.clientY - rect.top });
                  }}>
                  <rect x={0} y={y} width={width} height={rowH} fill="transparent" />
                  <text className="gantt-row-label" x={labelW - 8} y={y + 14} textAnchor="end" style={{ fontWeight: t.critical ? 650 : 400, fill: t.critical ? 'var(--text-primary)' : undefined }}>
                    {t.critical ? '◆ ' : ''}{t.name.length > 30 ? `${t.name.slice(0, 29)}…` : t.name}
                  </text>
                  <rect x={x1} y={y + 5} width={x2 - x1} height={rowH - 10} rx={3} style={{ fill: colorOf(t.phase), opacity: hover && hover.t.id !== t.id ? 0.55 : 1 }} />
                </g>
              );
            })}
            {schedule.milestones.map((m) => {
              const x = sx(Date.parse(m.date));
              return (
                <g key={m.id}>
                  <line x1={x} x2={x} y1={top - 4} y2={height - 24} style={{ stroke: 'var(--text-muted)', strokeWidth: 1 }} />
                  <path d={`M${x},${height - 22} l5,6 l-5,6 l-5,-6z`} style={{ fill: 'var(--text-primary)' }} />
                  <title>{`${m.name} — ${m.date}`}</title>
                </g>
              );
            })}
          </svg>
          {hover && (
            <div className="chart-tooltip" style={{ left: Math.min(hover.x + 12, width - 240), top: hover.y + 12 }}>
              <div className="t-title">{phaseLabel(hover.t.phase)}{hover.t.critical ? ` · ${tr('ui.gantt.critical')}` : ''}</div>
              <div style={{ fontWeight: 600 }}>{hover.t.name}</div>
              <div className="t-name">{fmtDate(hover.t.start)} → {fmtDate(hover.t.end)} ({tr('ui.gantt.days', { n: hover.t.durationDays.toFixed(0) })})</div>
              {hover.t.qty != null && <div className="t-name">{tr('ui.gantt.qty', { n: hover.t.qty.toLocaleString() })}</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
