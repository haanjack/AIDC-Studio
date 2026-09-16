import type { CableType, CatalogItem } from '../../model/types.ts';
import type { NodeSpec } from '../compose.ts';
import { AMD_CATALOG, AMD_NODES } from './amd.ts';
import { CABLE_SEEDS } from './cables.ts';
import { FACILITY_CATALOG } from './facility.ts';
import { HELIOS_CATALOG } from './helios.ts';
import { NPU_CATALOG, NPU_NODES } from './npu.ts';
import { NVIDIA_EXTRA_CATALOG, NVIDIA_NODES } from './nvidia-extra.ts';
import { SERVICE_NODES } from './service-nodes.ts';
import { NIC_CATALOG, SWITCH_CATALOG } from './switches.ts';
import { STD_COMPUTE_NETWORK_CATALOG, STD_NODE_SPECS } from './std-compute-network.ts';
import { STD_COOLING_CATALOG } from './std-cooling.ts';
import { STD_RACK_POWER_CATALOG } from './std-rack-power.ts';

/**
 * Additional builtin seeds (stream S3: NVIDIA extras / AMD / NPU / switches / NICs / cables / facility; S5: Helios).
 * catalog.ts concatenates `EXTRA_CATALOG` into `CATALOG` and `EXTRA_CABLE_TYPES` into `CABLE_TYPES`,
 * so seed files only need to be listed here. Every value that is not a public datasheet number carries
 * `source: 'estimate'` or `source: 'announced'` (see each item's `notes`).
 */
export const EXTRA_CATALOG: CatalogItem[] = [
  ...NVIDIA_EXTRA_CATALOG,
  ...AMD_CATALOG,
  ...HELIOS_CATALOG,
  ...NPU_CATALOG,
  ...SWITCH_CATALOG,
  ...NIC_CATALOG,
  ...FACILITY_CATALOG,
  // stream B (P2): standards building blocks (generic, vendor 'Generic'); appended last so vendor items keep their catalog order
  ...STD_RACK_POWER_CATALOG,
  ...STD_COOLING_CATALOG,
  ...STD_COMPUTE_NETWORK_CATALOG,
];
export const EXTRA_CABLE_TYPES: CableType[] = [...CABLE_SEEDS];

/** Node specs available to the node → rack composer (UI + seeds). */
export const NODE_SPECS: NodeSpec[] = [...NVIDIA_NODES, ...AMD_NODES, ...NPU_NODES, ...SERVICE_NODES, ...STD_NODE_SPECS];

export function findNodeSpec(id: string): NodeSpec | undefined {
  return NODE_SPECS.find((n) => n.id === id);
}

export { AMD_NODES, NVIDIA_NODES, NPU_NODES, SERVICE_NODES, CABLE_SEEDS };
export { CABLE_MEDIA_NOTES } from './cables.ts';
export type { CduRating } from './facility.ts';
export { STD_NODE_SPECS, STD_COMPUTE_NETWORK_CATALOG, NETWORK_POD_ARCHETYPES, MGMT_PROFILE_TAGS } from './std-compute-network.ts';
export { STD_COOLING_CATALOG, TCS_PIPE_BANDS, COOLANT_DESCRIPTORS, ITE_COOLING_CLASS_LIQUID_FRACTION, FWS_CLASS_SUPPLY_C } from './std-cooling.ts';
export { STD_RACK_POWER_CATALOG, SHELF_FEED_CLASSES } from './std-rack-power.ts';
export { NO_STANDARD, itemSpecStatus, kwPerLpm, type BlockKind } from './std-helpers.ts';
export { VENDOR_CLASSIFICATION, applyStandardsClassification } from './std-classification.ts';
