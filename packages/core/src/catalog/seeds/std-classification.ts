import type { CatalogItem } from '../../model/types.ts';
import type { ItemCdu, ItemStandard } from '../../standards/types.ts';
import { itemSpecStatus, NO_STANDARD, std } from './std-helpers.ts';

/**
 * Classification of the existing vendor / OEM catalog items (stream B / P2; OCP-DESIGN-PROPOSAL §3.4, R12).
 *
 * Explicit id table (no pattern matching on vendor names). Each entry declares which cited standard the instance implements and
 * at what level, with the evidence kind for claims that come from a vendor blog or press release (never promoted to verified).
 * `classId` names the generic class the instance maps to. Applied once when the builtin catalog is built (catalog.ts); ids,
 * numbers and everything that drives analysis totals stay unchanged.
 */

const ACCESSED = '2026-09-15';
const RACKSCALE_BLOG = { kind: 'vendor-blog' as const, label: 'NVIDIA technical blog: GB200 NVL72 designs contributed (2024-10-15)', url: 'https://developer.nvidia.com/blog/nvidia-contributes-nvidia-gb200-nvl72-designs-to-open-compute-project/', accessed: ACCESSED };
const HELIOS_PR = { kind: 'press-release' as const, label: 'AMD press release: Helios rack-scale platform (2025-10-14)', url: 'https://www.amd.com/en/newsroom/press-releases/2025-10-14-amd-showcases-helios-rack-scale-platform-built-o.html', accessed: ACCESSED };
const AMD_RD = { kind: 'product-page' as const, label: 'AMD MI3XX Reference Design', url: 'https://instinct.docs.amd.com/projects/MI3XX-reference/latest/index.html', accessed: ACCESSED };
const INTEL_BRIEF = { kind: 'product-page' as const, label: 'Intel Gaudi 3 HLB-325 baseboard product brief', url: 'https://cdrdv2-public.intel.com/817489/gaudi-3-ai-accelerator-hlb-325-baseboard-product-brief.pdf', accessed: ACCESSED };

const OAM = 'oam-base@2.0-1.0';
const UBB = 'ubb-base@2.0-1.0';

const eiaRack = std('eia-310@e', 'eia', 'rack', 'estimate');
const eiaFF = (units: number, usable = units) => ({ rack: 'eia-310-19' as const, unitPitchMm: 44.45 as const, heightUnits: units, usableUnits: usable });
const prop = (scope: ItemStandard['scope'], note: string, classId?: string) => std(NO_STANDARD, 'proprietary', scope, 'verified', { note, ...(classId ? { classId } : {}) });
const sai = (classId?: string) => std('sai@1.19.0', 'open-spec', 'network', 'unverified', { note: 'switch API / open NOS support per SKU not verified', ...(classId ? { classId } : {}) });

type Classification = Pick<CatalogItem, 'standards' | 'formFactor' | 'accelModule' | 'baseboard' | 'cdu'>;

const amdNode = (tdpW: number, cooling: 'air' | 'liquid'): Classification => {
  const notes: string[] = [];
  if (tdpW > 1000) notes.push(`declared module power ${tdpW.toLocaleString('en-US')} W is above the module power envelope (1000 W): flagged, still eligible`);
  if (cooling === 'air' && tdpW > 600) notes.push(`air-cooled module above the 600 W air recommendation`);
  return {
    standards: [
      std(OAM, 'open-spec', 'module', 'verified', { ...(notes.length ? { note: notes.join('; ') } : {}), classId: cooling === 'air' ? 'node-ubb8-oam-air' : 'node-ubb8-oam-dlc', evidence: AMD_RD }),
      std(UBB, 'open-spec', 'baseboard', 'unverified', { note: 'baseboard generation stated in vendor documentation; conformance not verified', evidence: AMD_RD }),
      prop('network', 'scale-up links are vendor-proprietary (Infinity Fabric)'),
    ],
    accelModule: { standard: 'oam-2.0', tdpW, cooling },
    baseboard: { standard: 'ubb-2.0', modules: 8, inputV: 54 },
  };
};

const hgx = (classNote = 'proprietary modules on a UBB-class 8-GPU baseboard'): Classification => ({
  standards: [std('gpu-mgmt-interfaces@1.1', 'open-platform-host', 'host', 'unverified', { note: classNote, classId: 'node-ubb8-sxm' })],
});

const vendorCdu = (classId: string, cdu: ItemCdu, note: string): Classification => ({ standards: [prop('liquid', note, classId)], cdu });

const air = (classId: string | undefined, note = 'vendor air handler; planning values'): Classification => ({ standards: [prop('facility', note, classId)] });

const appliance = (note = 'opaque accelerator appliance (footprint, kW, cooling, ports)'): Classification => ({ standards: [prop('rack', note, 'accelerator-appliance')] });

const npuModule = (note: string, classId = 'node-pcie-cem-8x'): Classification => ({ standards: [prop('module', note, classId)] });

export const VENDOR_CLASSIFICATION: Readonly<Record<string, Classification>> = {
  // ── rack-scale systems ──
  'nvidia-gb300-nvl72': {
    standards: [
      std('vendor-rackscale-orv3-width@2024-10-15', 'contributed-design', 'rack', 'unverified', { note: 'rack / tray designs of the previous generation stated as contributed by the vendor; acceptance and inheritance by this generation not verified', classId: 'rackscale-liquid-72', evidence: RACKSCALE_BLOG }),
      prop('module', 'compute trays and NVLink scale-up are proprietary'),
    ],
    formFactor: { rack: 'orv3-mgx', unitPitchMm: 44.45 },
  },
  'nvidia-gb200-nvl72': {
    standards: [
      std('vendor-rackscale-orv3-width@2024-10-15', 'contributed-design', 'rack', 'unverified', { note: 'rack / tray designs stated as contributed by the vendor (open-rack width, deeper 1,400 A busbar); acceptance not verified', classId: 'rackscale-liquid-72', evidence: RACKSCALE_BLOG }),
      prop('module', 'compute trays and NVLink scale-up are proprietary'),
    ],
    formFactor: { rack: 'orv3-mgx', unitPitchMm: 44.45 },
  },
  'nvidia-vr-nvl72': { standards: [prop('rack', 'proprietary rack-scale system; the vendor announced a contribution of its next rack and tray designs (2025-10), no contributed documents seen', 'rackscale-liquid-72')], formFactor: { rack: 'orv3-mgx', unitPitchMm: 44.45 } },
  'amd-helios-mi455x': {
    standards: [
      std('orw-base@1.0.0', 'open-spec', 'rack', 'unverified', { note: '"aligned with" the wide-rack standard per the vendor press release', classId: 'rackscale-liquid-72', evidence: HELIOS_PR }),
      prop('host', 'compute trays are proprietary'),
      std('ualink-200g@1.0', 'open-spec', 'network', 'unverified', { note: 'scale-up / scale-out alignment stated in the vendor press release only', evidence: HELIOS_PR }),
    ],
    formFactor: { rack: 'orw', unitPitchMm: 48, heightUnits: 44, usableUnits: 44 },
  },
  'nvidia-groq3-lpx': appliance('opaque accelerator appliance; physical values not published'),
  'groq-groqrack': { ...appliance(), formFactor: eiaFF(42) },
  'sambanova-sn40l-16': appliance(),
  // ── 8-accelerator nodes ──
  'hgx-b200-air-4x': { ...hgx(), standards: [eiaRack, ...hgx().standards!], formFactor: eiaFF(48) },
  'hgx-h100-air-4x': hgx(),
  'hgx-h200-air-4x': hgx(),
  'hgx-b300-air-4x': hgx(),
  'amd-mi300x-air-4x': amdNode(750, 'air'),
  'amd-mi325x-air-3x': amdNode(1000, 'air'),
  'amd-mi350x-air-3x': amdNode(1000, 'air'),
  'amd-mi355x-dlc-4x': amdNode(1400, 'liquid'),
  'amd-mi355x-air-2x': amdNode(1400, 'air'),
  'intel-gaudi3-air-4x': {
    standards: [std(OAM, 'open-spec', 'module', 'verified', { note: 'modules in the OAM outline (900 W air; the 1,200 W liquid variant is above the 1000 W envelope and the air value above the 600 W air recommendation); board 417 × 585 mm vs 417 × 655 mm, so baseboard outline conformance is not implied', classId: 'node-ubb8-oam-air', evidence: INTEL_BRIEF })],
    accelModule: { standard: 'oam-2.0', tdpW: 900, cooling: 'air' },
  },
  // ── NPU / alternative accelerators ──
  'rebellions-rebel-quad-4x': npuModule('PCIe add-in accelerator cards (2 × PCIe Gen5 x16 per brochure v1.2); an OAM module form factor is not supported by public material'),
  'rebellions-atom-max-8x': npuModule('PCIe accelerator cards (proprietary)'),
  'furiosa-rngd-10x': npuModule('PCIe accelerator cards (proprietary)'),
  'hyperaccel-orion-8x': npuModule('PCIe accelerator cards (proprietary)'),
  'hyperaccel-bertha500-8x': npuModule('PCIe accelerator cards (proprietary)'),
  'tenstorrent-galaxy-4x': npuModule('proprietary accelerator server', 'accelerator-appliance'),
  'cerebras-cs3-2x': npuModule('wafer-scale appliance (proprietary)', 'accelerator-appliance'),
  'google-tpu7x-cloud': { standards: [prop('host', 'cloud-only reference; not placeable')] },
  // ── CPU / storage / network / management racks ──
  'cpu-rack-2s-20': { standards: [eiaRack], formFactor: eiaFF(48) },
  'storage-rack-afa': { standards: [eiaRack], formFactor: eiaFF(48) },
  'network-rack-48u': { standards: [eiaRack], formFactor: eiaFF(48, 42) },
  'mgmt-rack-42u': { standards: [eiaRack], formFactor: eiaFF(42) },
  // ── switches ──
  'nvidia-q3400': { standards: [eiaRack, prop('network', 'InfiniBand fabric; outside open networking specifications')] },
  'nvidia-qm9700': { standards: [eiaRack, prop('network', 'InfiniBand fabric; outside open networking specifications')] },
  'nvidia-sn5600': { standards: [eiaRack, sai('switch-eth-51t-64x800')] },
  'nvidia-sn5400': { standards: [eiaRack, sai()] },
  'nvidia-sn2201': { standards: [eiaRack, sai('switch-oob-1g-48')] },
  'nvidia-sn6600': { standards: [eiaRack, sai('switch-eth-102t-128x800')] },
  'nvidia-sn6800': { standards: [eiaRack, sai()] },
  'generic-roce-400': { standards: [eiaRack, sai()] },
  'generic-roce-800': { standards: [eiaRack, sai()] },
  'broadcom-th5-64x800': { standards: [eiaRack, sai('switch-eth-51t-64x800')] },
  'broadcom-th6-128x800': { standards: [eiaRack, sai('switch-eth-102t-128x800')] },
  'dell-z9864f-on': { standards: [eiaRack, sai('switch-eth-51t-64x800')] },
  'arista-7700r4c-38pe': { standards: [eiaRack, sai()] },
  'arista-7720r4-128pe': { standards: [eiaRack, sai()] },
  'cisco-n9364e-sg2': { standards: [eiaRack, sai()] },
  'juniper-qfx5240-64od': { standards: [eiaRack, sai()] },
  'drivenets-2500s': { standards: [eiaRack, prop('network', 'scheduled / vendor fabric operating system')] },
  'drivenets-5300r': { standards: [eiaRack, prop('network', 'scheduled / vendor fabric operating system')] },
  'drivenets-9300f': { standards: [eiaRack, prop('network', 'scheduled / vendor fabric operating system')] },
  // ── NICs ──
  'nvidia-cx7-400': { standards: [prop('nic', 'PCIe CEM adapter (NIC 3.0 variants are separate SKUs, not modelled)')] },
  'nvidia-cx8-800': { standards: [prop('nic', 'PCIe CEM adapter (NIC 3.0 variants are separate SKUs, not modelled)')] },
  'nvidia-cx9-1600': { standards: [prop('nic', 'announced; form factor not stated')] },
  'amd-pollara-400': { standards: [prop('nic', 'PCIe CEM adapter (NIC 3.0 variants are separate SKUs, not modelled)')] },
  'broadcom-thor2-400': { standards: [prop('nic', 'PCIe CEM adapter (NIC 3.0 variants are separate SKUs, not modelled)')] },
  // ── CDUs (rating basis stored, never assumed) ──
  'vertiv-xdu1350': vendorCdu('cdu-row-l2l-1400', { class: 'row-l2l', ratedKW: 1350, ratedApproachK: 4, pumpRedundancy: 'N+1', dualFeed: true, ratingBasis: { convention: 'loop-reqs-4k', approachK: 4 } }, 'vendor CDU rated at a 4 °C approach'),
  'vertiv-xdu2300': vendorCdu('cdu-facility-2mw', { class: 'facility', ratedKW: 2300, ratedApproachK: 4, pumpRedundancy: 'N+1', dualFeed: true, ratingBasis: { convention: 'loop-reqs-4k', approachK: 4 } }, 'vendor CDU rated at a 4 °C approach'),
  'vertiv-coolchip-cdu-2300': vendorCdu('cdu-facility-2mw', { class: 'facility', ratedKW: 2300, ratedApproachK: 4, pumpRedundancy: 'N+1', dualFeed: true, ratingBasis: { convention: 'loop-reqs-4k', approachK: 4 } }, 'vendor CDU rated at a 4 °C approach'),
  'coolit-chx2000': vendorCdu('cdu-facility-2mw', { class: 'facility', ratedKW: 2000, ratedApproachK: 5, tcsLpmPerKW: 1.06, pumpRedundancy: 'unstated', ratingBasis: { convention: 'vendor', approachK: 5, lpmPerKW: 1.06, tcsHeadPsi: 35 } }, 'vendor CDU rated at 5 °C ATD with 1.06 L/min per kW (not the 1.5 L/min per kW row convention)'),
  'motivair-mcdu-70': vendorCdu('cdu-facility-2mw', { class: 'facility', ratedKW: 2500, ratedApproachK: 4, pumpRedundancy: '2 pumps', dualFeed: true, ratingBasis: { convention: 'vendor', approachK: 4, tcsHeadPsi: 38 } }, 'vendor CDU; approach ≈4 K derived from the rated temperatures'),
  'boyd-rol4000': vendorCdu('cdu-facility-2mw', { class: 'facility', ratedKW: 2000, ratedApproachK: 3, pumpRedundancy: 'N+1', dualFeed: true, ratingBasis: { convention: 'vendor', approachK: 3, tcsHeadPsi: 80 } }, 'vendor CDU rated at a 3 °C approach'),
  // ── air handlers / UPS ──
  'vertiv-cw084': air('crah-generic-100'),
  'vertiv-cw181': air('crah-generic-250'),
  'vertiv-cw375': air('crah-generic-400'),
  'liebert-cwa-fanwall-600': air('fanwall-generic-600', 'vendor fan-wall air handler; planning values'),
  'vertiv-exl-s1-1200': { standards: [prop('facility', 'vendor UPS; planning values', 'ups-generic-1200')] },
  'vertiv-apm2-150': { standards: [prop('facility', 'vendor modular UPS; planning values')] },
};

/**
 * Adds the classification to builtin items (new objects; existing `standards` entries are kept and deduplicated by id + scope)
 * and derives `specStatus` from the registry ids an item declares.
 */
export function applyStandardsClassification(items: CatalogItem[]): CatalogItem[] {
  return items.map((it) => {
    const c = VENDOR_CLASSIFICATION[it.id];
    if (!c) return it;
    const standards: ItemStandard[] = [...(it.standards ?? [])];
    for (const s of c.standards ?? []) if (!standards.some((x) => x.standardId === s.standardId && x.scope === s.scope)) standards.push(s);
    const out: CatalogItem = { ...it, standards };
    if (c.formFactor && !it.formFactor) out.formFactor = c.formFactor;
    if (c.accelModule && !it.accelModule) out.accelModule = c.accelModule;
    if (c.baseboard && !it.baseboard) out.baseboard = c.baseboard;
    if (c.cdu && !it.cdu) out.cdu = c.cdu;
    const status = itemSpecStatus(standards);
    if (status) out.specStatus = status;
    else delete out.specStatus;
    return out;
  });
}
