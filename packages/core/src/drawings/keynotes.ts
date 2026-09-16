// r4 keynote vocabulary (spec §1.3, S10: AIDC's own numbers, not the deck's). Owner: stream B0 (hand-off B → C: KEYNOTES).
// Each sheet lists only the keynotes it uses; 001 lists all.
import type { Locale } from '../model/types.ts';
import type { LayerId } from '../scene/layers.ts';
import type { Prim } from '../scene/prims.ts';

export interface Keynote {
  /** 2-digit id shown in the ellipse */
  id: string;
  key: string;
  label: Record<Locale, string>;
  layer: LayerId;
}

const K = (id: string, key: string, en: string, ko: string, layer: LayerId): Keynote => ({ id, key, label: { en, ko }, layer });

export const KEYNOTES: readonly Keynote[] = [
  K('01', 'rack', 'Rack', '랙', 'racks'),
  K('02', 'rack-end-panel', 'Rack end panel', '랙 끝 패널', 'racks'),
  K('03', 'containment-panel', 'Containment panel', '컨테인먼트 패널', 'containment'),
  K('04', 'containment-roof', 'Containment roof / chimney', '컨테인먼트 지붕 / 침니', 'containment-roof'),
  K('05', 'containment-door', 'Containment door', '컨테인먼트 문', 'containment-doors'),
  K('06', 'rcu-enclosure', 'RCU enclosure', 'RCU 인클로저', 'rcu-enclosures'),
  K('10', 'busway-a', 'Busway A', '버스웨이 A', 'busway-a'),
  K('11', 'busway-b', 'Busway B', '버스웨이 B', 'busway-b'),
  K('12', 'tapoff', 'Tap-off box', '탭오프 박스', 'tapoffs'),
  K('13', 'feeder-sleeve', 'Feeder / wall sleeve', '피더 / 벽 슬리브', 'feeders'),
  K('20', 'ladder-t1', 'Cable ladder T1', '케이블 래더 T1', 'tray-t1'),
  K('21', 'ladder-t2', 'Cable ladder T2', '케이블 래더 T2', 'tray-t2'),
  K('22', 'ladder-t3', 'Cable ladder T3', '케이블 래더 T3', 'tray-t3'),
  K('23', 'drop', 'Cable drop', '케이블 드롭', 'drops'),
  K('30', 'tcs-supply', 'TCS supply', 'TCS 공급', 'pipes'),
  K('31', 'tcs-return', 'TCS return', 'TCS 환수', 'pipes'),
  K('32', 'cdu', 'CDU', 'CDU', 'cdu-crah'),
  K('33', 'valve-set', 'EPIV / valve set', 'EPIV / 밸브 세트', 'pipe-fittings'),
  K('40', 'column', 'Column', '기둥', 'columns'),
  K('41', 'wall', 'Wall', '벽', 'walls'),
  K('42', 'door', 'Door', '문', 'doors'),
  K('50', 'light-strip', 'Light strip', '조명 스트립', 'lights'),
];

const BY_ID = new Map<string, Keynote>();
for (const k of KEYNOTES) {
  BY_ID.set(k.id, k);
  BY_ID.set(k.key, k);
}

export function keynote(idOrKey: string): Keynote | undefined {
  return BY_ID.get(idOrKey);
}

export function keynoteLabel(id: string, locale: Locale): string {
  return BY_ID.get(id)?.label[locale] ?? id;
}

/**
 * Keynote id for a prim (or a draw item's prim fields), or undefined when the vocabulary has no entry.
 * Rules: rack 01 · rcu-enclosures layer 06 · containment panel 03 / roof 04 / door on containment-doors 05 · busway A/B 10/11 ·
 * tap-off 12 · feeder / sleeve 13 · tray by tier T1/T2/T3 20/21/22 · drop 23 · pipe supply/return 30/31 · CDU unit 32 ·
 * fitting 33 · column 40 · wall / partition 41 · room door 42 · light 50.
 */
export function keynoteForPrim(p: Pick<Prim, 'emitter' | 'layer'> & Partial<Pick<Prim, 'system' | 'tier' | 'meta'>>): string | undefined {
  if (p.layer === 'rcu-enclosures') return '06';
  switch (p.emitter) {
    case 'rack':
      return '01';
    case 'containment-panel':
      return '03';
    case 'containment-roof':
      return '04';
    case 'door':
      return p.layer === 'containment-doors' ? '05' : '42';
    case 'busway':
      return p.system === 'busway-b' || p.layer === 'busway-b' ? '11' : '10';
    case 'tapoff':
      return '12';
    case 'feeder':
    case 'sleeve':
      return '13';
    case 'tray': {
      const t = p.tier ?? (p.layer === 'tray-t2' ? 'T2' : p.layer === 'tray-t3' ? 'T3' : 'T1');
      return t === 'T3' ? '22' : t === 'T2' ? '21' : '20';
    }
    case 'drop':
      return '23';
    case 'pipe':
      return p.system === 'cdu-return' ? '31' : '30';
    case 'unit':
      return p.layer === 'cdu-crah' && (p.meta?.category === undefined || p.meta.category === 'cdu') ? '32' : undefined;
    case 'fitting':
      return '33';
    case 'column':
      return '40';
    case 'wall':
    case 'partition':
      return '41';
    case 'light':
      return '50';
    default:
      return undefined;
  }
}

/** The keynotes of a set of ids, unique, in vocabulary order. */
export function keynotesUsed(ids: Iterable<string | undefined>): Keynote[] {
  const want = new Set<string>();
  for (const id of ids) if (id) want.add(BY_ID.get(id)?.id ?? id);
  return KEYNOTES.filter((k) => want.has(k.id));
}
