import type { FabricOptions, PodTemplate } from '../generate.ts';

/**
 * Vendor sample data (stream D / P4; OCP-DESIGN-PROPOSAL §4.3, §7.2; DECISIONS-v2-2 §I DO-7).
 *
 * Leaf module (type-only imports): the ONE place in `layout/` that names vendor catalog instances for templates and the vendor
 * sample project. Standard templates, the neutral reference and the generator defaults use generic class ids; vendor products
 * are optional instances listed here as curated suggestions.
 */

/** Rack-scale NVLink-class systems (vendor instances of the 72-accelerator rack-scale domain). */
export const NVIDIA_RACK_SCALE = ['nvidia-gb300-nvl72', 'nvidia-gb200-nvl72', 'nvidia-vr-nvl72'];
/** UBB 2.0 (UBB8) 8-OAM node racks. */
export const AMD_UBB8_RACKS = ['amd-mi300x-air-4x', 'amd-mi325x-air-3x', 'amd-mi350x-air-3x', 'amd-mi355x-dlc-4x', 'amd-mi355x-air-2x'];
/** HGX 8-GPU node racks. */
export const NVIDIA_HGX_RACKS = ['hgx-b200-air-4x', 'hgx-b300-air-4x', 'hgx-h100-air-4x', 'hgx-h200-air-4x'];
/** Known NPU / alternative-accelerator rack seeds (catalog/seeds/npu.ts; the cloud-only TPU reference is not placeable). */
export const NPU_RACKS = ['intel-gaudi3-air-4x', 'rebellions-atom-max-8x', 'rebellions-rebel-quad-4x', 'furiosa-rngd-10x', 'hyperaccel-orion-8x', 'hyperaccel-bertha500-8x', 'tenstorrent-galaxy-4x', 'cerebras-cs3-2x', 'groq-groqrack', 'sambanova-sn40l-16'];
/** Air-cooled 19-inch racks among the NPU seeds (declared EIA form, no liquid): suggestions for the 19-inch air pod. */
export const AIR_EIA_NPU_RACKS = ['intel-gaudi3-air-4x', 'rebellions-atom-max-8x', 'rebellions-rebel-quad-4x', 'furiosa-rngd-10x', 'hyperaccel-orion-8x', 'hyperaccel-bertha500-8x', 'tenstorrent-galaxy-4x', 'groq-groqrack'];
/** Air-cooled UBB8 node racks (the liquid MI355X rack is excluded). */
export const AIR_UBB8_RACKS = ['amd-mi300x-air-4x', 'amd-mi325x-air-3x', 'amd-mi350x-air-3x', 'amd-mi355x-air-2x'];
/** Liquid-cooled 19-inch UBB8 node racks. */
export const DLC_UBB8_RACKS = ['amd-mi355x-dlc-4x'];
/** Wide-rack rack-scale vendor instance. */
export const WIDE_RACK_SCALE = ['amd-helios-mi455x'];
/**
 * Pod of the vendor sample (the pre-P4 reference deployment unit): 2 × 12 rack-scale systems, 24 ft DU pitch, row-start CDUs,
 * vendor scale-out switch. Kept byte-identical so the vendor sample project and its goldens do not move.
 */
export const VENDOR_RACKSCALE_POD: PodTemplate = {
  gpuRackCatalogId: 'nvidia-gb300-nvl72',
  racksPerRow: 12,
  innerAisleM: 2.22,
  outerAisleM: 7.3152 - (1.2 * 2 + 2.22),
  containment: 'hot-aisle',
  cduCatalogId: 'vertiv-xdu2300',
  cdusPerPod: 'auto',
  cduRedundancy: 'N+1',
  scaleOutSwitchCatalogId: 'nvidia-q3400',
  oversubscription: 1,
  networkRacksPerPod: 'auto',
};

/** Aux fabrics of the vendor sample (front-end / storage / OOB switch instances the sample project also stores in `network`). */
export const VENDOR_SAMPLE_FABRICS: Required<FabricOptions> = {
  frontend: { enabled: true, switchCatalogId: 'nvidia-sn5400', oversubscription: 2 },
  storage: { enabled: true, switchCatalogId: 'nvidia-sn5400', oversubscription: 1 },
  oob: { enabled: true, switchCatalogId: 'nvidia-sn2201' },
};

/** Vendor scale-out switches used by the vendor-sample row templates. */
export const VENDOR_SAMPLE_SWITCHES = { spectrum800: 'nvidia-sn5600', wide800: 'broadcom-th6-128x800' } as const;

/** Vendor instances of the vendor sample project (facility side). */
export const VENDOR_SAMPLE_FACILITY = { crah: 'vertiv-cw375', ups: 'vertiv-exl-s1-1200', scaleOut: 'nvidia-q3400' } as const;
