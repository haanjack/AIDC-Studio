// r4 contract (spec §3.2 Layers): the layer registry shared by the 2D view (Plan · Section · Elevation), the sheets (data-layer
// groups) and the prims. Owner after the contract: stream A. UI labels come from the web `view2d` namespace via `i18nKey`.

export type LayerGroup = 'architecture' | 'racks' | 'containment' | 'power' | 'cable' | 'cooling' | 'annotation';

/** exists = in the model · derived = computed by a rule · pending = needs data not in the model yet */
export type LayerStatus = 'exists' | 'derived' | 'pending';

export type LayerId =
  // architecture
  | 'hall-outline' | 'walls' | 'structural-grid' | 'planning-grid' | 'columns' | 'doors' | 'egress' | 'partitions' | 'rooms' | 'sleeves'
  | 'slab' | 'ceiling' | 'lights'
  // racks
  | 'racks' | 'form-factor' | 'front-tick' | 'rcu-enclosures' | 'reserves'
  // containment
  | 'containment' | 'containment-roof' | 'containment-doors'
  // power
  | 'busway-a' | 'busway-b' | 'tapoffs' | 'circuits' | 'feeders' | 'electrical-rooms'
  // cable
  | 'tray-t1' | 'tray-t2' | 'tray-t3' | 'drops' | 'network-cables'
  // cooling
  | 'cdu-crah' | 'pipes' | 'pipe-fittings'
  // annotation
  | 'tags' | 'position-tags' | 'dimensions' | 'datums' | 'keynotes' | 'notes' | 'sensors';

export interface LayerDef {
  id: LayerId;
  group: LayerGroup;
  /** web i18n key (namespace view2d) */
  i18nKey: string;
  status: LayerStatus;
  /** visible when the 2D view opens with no remembered state */
  defaultOn: boolean;
}

const L = (id: LayerId, group: LayerGroup, status: LayerStatus, defaultOn = true): LayerDef => ({ id, group, i18nKey: `view2d.layer.${id}`, status, defaultOn });

/** Registry in display order (groups contiguous). */
export const LAYERS: readonly LayerDef[] = [
  L('hall-outline', 'architecture', 'exists'),
  L('walls', 'architecture', 'derived'),
  L('structural-grid', 'architecture', 'derived'),
  L('planning-grid', 'architecture', 'exists', false),
  L('columns', 'architecture', 'exists'),
  L('doors', 'architecture', 'derived'),
  L('egress', 'architecture', 'exists'),
  L('partitions', 'architecture', 'exists'),
  L('rooms', 'architecture', 'exists'),
  L('sleeves', 'architecture', 'pending'),
  L('slab', 'architecture', 'derived'),
  L('ceiling', 'architecture', 'exists', false),
  L('lights', 'architecture', 'derived', false),
  L('racks', 'racks', 'exists'),
  L('form-factor', 'racks', 'derived', false),
  L('front-tick', 'racks', 'exists'),
  L('rcu-enclosures', 'racks', 'derived'),
  L('reserves', 'racks', 'exists'),
  L('containment', 'containment', 'exists'),
  L('containment-roof', 'containment', 'exists'),
  L('containment-doors', 'containment', 'derived'),
  L('busway-a', 'power', 'exists'),
  L('busway-b', 'power', 'exists'),
  L('tapoffs', 'power', 'exists'),
  L('circuits', 'power', 'exists', false),
  L('feeders', 'power', 'exists', false),
  L('electrical-rooms', 'power', 'exists'),
  L('tray-t1', 'cable', 'derived'),
  L('tray-t2', 'cable', 'derived'),
  L('tray-t3', 'cable', 'derived'),
  L('drops', 'cable', 'derived'),
  L('network-cables', 'cable', 'derived', false),
  L('cdu-crah', 'cooling', 'exists'),
  L('pipes', 'cooling', 'derived'),
  L('pipe-fittings', 'cooling', 'pending', false),
  L('tags', 'annotation', 'exists'),
  L('position-tags', 'annotation', 'derived'),
  L('dimensions', 'annotation', 'derived'),
  L('datums', 'annotation', 'derived'),
  L('keynotes', 'annotation', 'derived', false),
  L('notes', 'annotation', 'derived', false),
  L('sensors', 'annotation', 'pending', false),
];

export const LAYER_GROUPS: readonly LayerGroup[] = ['architecture', 'racks', 'containment', 'power', 'cable', 'cooling', 'annotation'];

const BY_ID = new Map(LAYERS.map((d) => [d.id, d]));

export function layerDef(id: LayerId): LayerDef | undefined {
  return BY_ID.get(id);
}

export type LayerPresetId = 'arch' | 'power' | 'cooling' | 'network' | 'all';

const ARCH_BASE: LayerId[] = ['hall-outline', 'walls', 'structural-grid', 'columns', 'doors', 'egress', 'partitions', 'rooms', 'slab'];
const RACK_BASE: LayerId[] = ['racks', 'front-tick', 'tags'];

/** Presets (spec §3.2): Arch / Power / Cooling / Network / All. */
export const LAYER_PRESETS: Record<LayerPresetId, readonly LayerId[]> = {
  arch: [...ARCH_BASE, 'planning-grid', 'sleeves', 'racks', 'front-tick', 'rcu-enclosures', 'reserves', 'containment', 'containment-roof', 'containment-doors', 'tags', 'position-tags', 'dimensions', 'datums', 'keynotes'],
  power: [...ARCH_BASE, ...RACK_BASE, 'busway-a', 'busway-b', 'tapoffs', 'circuits', 'feeders', 'electrical-rooms', 'sleeves', 'datums'],
  cooling: [...ARCH_BASE, ...RACK_BASE, 'containment', 'containment-roof', 'containment-doors', 'cdu-crah', 'pipes', 'pipe-fittings', 'datums'],
  network: [...ARCH_BASE, ...RACK_BASE, 'tray-t1', 'tray-t2', 'tray-t3', 'drops', 'network-cables', 'sleeves', 'datums'],
  all: LAYERS.map((d) => d.id),
};
