import type { StandardFamily, StandardRef, StandardsPresetId, StandardsProfile } from './types.ts';

/**
 * Standards registry (stream A / P1; proposal §2.1, Appendix A, P0 closure log 2026-09-15).
 *
 * Data only: title / version / date / public URL / licence / status per cited document revision. No document text.
 * Entries are immutable — a newer revision is appended with `supersedes`, so projects can pin `id@version`.
 * Listing-page URLs are used where the research notes recorded no direct document URL.
 */

const DOCS = 'https://www.opencompute.org/documents/';
const RACK_WIKI = 'https://www.opencompute.org/wiki/Open_Rack/SpecsAndDesigns';

export const STANDARDS_REGISTRY: readonly StandardRef[] = [
  // ── rack ──
  { id: 'orv3-base@1.1', family: 'rack', title: 'Open Rack V3 Base Specification', version: 'Rev 1.1', date: '2024-03-05', url: RACK_WIKI, licence: 'hw-permissive', status: 'accepted', docType: 'base-spec' },
  { id: 'orv3-frame-meta@1.3', family: 'rack', title: 'Meta Open Rack Frame V3 Specification', version: 'Rev 1.3', date: '2024-06-03', url: `${DOCS}open-rack-version-meta-v3-rev1pt3-june032024-pdf`, licence: 'owfa-1.0-mod', status: 'contributed', docType: 'design-spec', notes: 'Frame implementation used by the neutral reference: 600 × 1068 mm, 44 OU, 1400 kg payload excluding the frame, 80 kg per IT shelf set (P0).' },
  { id: 'orv3-frame-google@0.2', family: 'rack', title: 'Google Implementation of the Open Rack Frame V3', version: 'Rev 0.2', date: '2022-09', url: RACK_WIKI, licence: 'owfa-1.0', status: 'contributed', docType: 'design-spec', notes: 'Weight values are rack totals; not used for populated liquid-cooled racks.' },
  { id: 'orw-base@1.0.0', family: 'rack', title: 'Open Rack Wide (ORW) Base Specification', version: 'V1.0.0', date: '2026-04-28', url: `${DOCS}open-rack-wide-orw-base-specification-v1-0-0-final-pdf`, licence: 'owfa-0.9-mod', status: 'accepted', docType: 'base-spec', notes: 'Released (P0); shown without a draft chip.' },
  { id: 'orw-meta-design@1.0.0', family: 'rack', title: 'Open Rack Wide (ORW) Meta Design Specification', version: 'V1.0.0', date: '2026-04-28', url: `${DOCS}open-rack-wide-orw-meta-design-specification-v1-0-0-final-pdf`, licence: 'owfa-0.9-mod', status: 'accepted', docType: 'design-spec' },
  { id: 'eia-310@e', family: 'rack', title: 'EIA-310 Cabinets, Racks, Panels and Associated Equipment', version: 'E', date: '', url: RACK_WIKI, licence: 'proprietary', status: 'external', docType: 'industry-standard', notes: 'Paid standard, not read; only the 44.45 mm unit pitch is used (as cited in the ORv3 base specification).' },
  // ── rack power ──
  { id: 'orv3-psu-48v@1.0', family: 'rack-power', title: 'Open Rack V3 48V PSU Specification', version: 'Rev 1.0', date: '2022-11-10', url: RACK_WIKI, licence: 'owfa-1.0', status: 'accepted', docType: 'design-spec' },
  { id: 'orv3-bbu-module@1.4', family: 'rack-power', title: 'Open Rack V3 48V BBU Module Specification', version: 'Rev 1.4', date: '2023-09-12', url: `${DOCS}open-rack-v3-bbu-module-spec-1-4-pdf`, licence: 'owfa-1.0-mod', status: 'accepted', docType: 'design-spec', notes: 'End-of-life threshold default 90 s full-power backup (P0); 240 s beginning-of-life shown as info.' },
  { id: 'orv3-bbu-shelf@1.1', family: 'rack-power', title: 'Open Rack V3 BBU Shelf Specification', version: 'Rev 1.1', date: '', url: `${DOCS}open-rack-v3-bbu-shelf-spec-rev1-1-pdf-1`, licence: 'owfa-1.0-mod', status: 'accepted', docType: 'design-spec' },
  { id: 'orv3-shelf-input-connector@1.0', family: 'rack-power', title: 'ORv3 Power Shelf Universal Input Power Connector', version: 'V1.0', date: '2022-09-09', url: `${DOCS}ocp-spec-v1-0-orv3-power-shelf-universal-input-power-connector-pdf`, licence: 'unknown', status: 'accepted', docType: 'design-spec' },
  { id: 'orv3-output-connector@2.0', family: 'rack-power', title: 'Open Rack V3 48V Power Output Connector', version: 'Rev 2.0', date: '', url: `${DOCS}ocp-open-rack-v3-power-output-connector-rev2-0-pdf`, licence: 'unknown', status: 'accepted', docType: 'design-spec' },
  { id: 'orv3-hpr-shelf-33kw@0.3', family: 'rack-power', title: 'ORv3 HPR 33 kW Power Shelf', version: 'Rev 0.3', date: '2024-04-29', url: RACK_WIKI, licence: 'owfa-1.0', status: 'draft', docType: 'design-spec', notes: 'Still the latest HPR v1 shelf revision (P0).' },
  { id: 'orv3-hpr-bbu-shelf-33kw@0.5', family: 'rack-power', title: 'ORv3 HPR BBU Shelf 33 kW', version: 'Rev 0.5', date: '', url: RACK_WIKI, licence: 'owfa-1.0', status: 'draft', docType: 'design-spec' },
  { id: 'hpr-v2-psu-12kw@1.0.0', family: 'rack-power', title: 'Open Rack V3 HPR V2 12kW PSU Specification', version: 'Rev 1.0.0', date: '2026-06-12', url: `${DOCS}open-rack-v3-hpr-v2-12kw-psu-module-spec-v1-0-0-pdf`, licence: 'owfa-0.9-mod', status: 'accepted', docType: 'design-spec' },
  { id: 'hpr-v2-shelf-72kw@1.0', family: 'rack-power', title: 'HPR V2 72kW Power Shelf Design Specification', version: 'Rev 1.0', date: '2026-04-14', url: RACK_WIKI, licence: 'owfa-1.0', status: 'review', docType: 'design-spec', notes: 'Under review; HPRv3 power-rack vertical busbar only (behind the drafts toggle).' },
  { id: 'hpr-2000a-output-connector@1.0.0', family: 'rack-power', title: 'HPR 2000A DC Power Output Connector Design Specification', version: 'Rev 1.0.0', date: '2026-06-23', url: `${DOCS}ocp-orv3-hpr-2000a-dc-power-output-connector-rev1-0-0-final-pdf`, licence: 'owfa-0.9-mod', status: 'accepted', docType: 'design-spec' },
  { id: 'hpr-v2-pmm@1.0.0', family: 'mgmt', title: 'HPR V2 Power Monitoring Module (PMM)', version: 'Rev 1.0.0', date: '2026-08-04', url: `${DOCS}ocp-open-rack-v3-hpr-v2-power-monitoring-module-pmm-rev-1-0-0-final-pdf`, licence: 'owfa-0.9-mod', status: 'accepted', docType: 'design-spec' },
  { id: 'diablo400@0.7.0', family: 'rack-power', title: 'Diablo 400 Project: Rack and Power Base Specification', version: '0.7.0', date: '2026-03-01', url: `${DOCS}ocp-specification-diablo-400-v0-7-0-final-pdf`, licence: 'owfa-0.9-mod', status: 'draft', docType: 'base-spec', supersedes: 'diablo400@0.5.2', notes: 'Pre-1.0: checks built on it stay warning-capped.' },
  { id: 'diablo400@0.5.2', family: 'rack-power', title: 'Diablo 400 Project: Rack and Power Base Specification', version: '0.5.2', date: '2025-05-30', url: `${DOCS}ocp-specification-diablo-400-v0p5p2-2025-05-30-pdf`, licence: 'owfa-0.9-mod', status: 'draft', docType: 'base-spec' },
  // ── liquid ──
  { id: 'uqd@1.0', family: 'liquid', title: 'Universal Quick Disconnect (UQD) Specification', version: 'Rev 1.0', date: '2020-09-04', url: `${DOCS}ocp-universal-quick-disconnect-uqd-specification-rev-1-0-2-pdf`, licence: 'hw-permissive', status: 'accepted', docType: 'design-spec' },
  { id: 'uqdb@1.0', family: 'liquid', title: 'Blind-Mate Universal Quick Disconnect (UQDB) Specification', version: 'Rev 1.0', date: '', url: `${DOCS}uqdb-spec-1-0-pdf`, licence: 'hw-permissive', status: 'accepted', docType: 'design-spec' },
  { id: 'orv3-bmqc@1.0', family: 'liquid', title: 'ORv3 Blind Mate Quick Connector Specification', version: 'Rev 1.0', date: '2024-06-04', url: `${DOCS}orv3-blind-mate-quick-connector-specification-rev01-04june2024-pdf`, licence: 'unknown', status: 'accepted', docType: 'design-spec' },
  { id: 'orv3-bm-manifold@1.0', family: 'liquid', title: 'Open Rack V3 Blind Mate Manifold Specification', version: 'Rev 1.0', date: '2024-04-05', url: `${DOCS}open-rack-v3-blind-mate-manifold-specification-rev-1-0-review-april05-2024-pdf`, licence: 'unknown', status: 'review', docType: 'design-spec', notes: 'Revision table says initial draft; acceptance not confirmed.' },
  { id: 'lqc@2.0.0', family: 'liquid', title: 'Large Quick Connector Specification', version: 'V2.0.0', date: '2026-07-15', url: `${DOCS}large-quick-connector-specification-version-2-0-0-final-pdf`, licence: 'owfa-0.9-mod', status: 'accepted', docType: 'design-spec', supersedes: 'lqc@1.0' },
  { id: 'lqc@1.0', family: 'liquid', title: 'Large Quick Connector Specification', version: 'V1.0', date: '2023-02-21', url: `${DOCS}ocp-large-quick-connector-specification-052223-pdf`, licence: 'hw-permissive', status: 'accepted', docType: 'design-spec', notes: 'Superseded by V2.0.0; do not use its pressure values.' },
  { id: 'pbmc@1.0', family: 'liquid', title: 'Pivoting Blind Mate Coupling (PBMC) Specification', version: 'Rev 1.0', date: '2026-04-15', url: `${DOCS}pbmc-design-specification1-0-final-pdf`, licence: 'unknown', status: 'accepted', docType: 'design-spec', notes: 'Fit with the ORv3 blind-mate manifold not established.' },
  { id: 'rpu@1.0', family: 'liquid', title: 'Reservoir and Pumping Unit (RPU) Specification', version: 'v1.0', date: '2022-11', url: `${DOCS}ocp-reservoir-and-pumping-unit-specification-v1-0-pdf`, licence: 'unknown', status: 'accepted', docType: 'design-spec' },
  { id: 'rack-manifold-wp@2023', family: 'liquid', title: 'Guidelines to Rack Manifold Requirements and Qualification (white paper)', version: 'v3', date: '2023-11', url: `${DOCS}ocp-white-paper-rack-manifold-requirements-and-qualification-v3-pdf`, licence: 'cc-by-sa-4.0', status: 'accepted', docType: 'white-paper' },
  { id: 'cold-plate-loop-reqs@2', family: 'liquid', title: 'Cold Plate Cooling Loop Requirements', version: 'Rev 2', date: '', url: `${DOCS}cold-plate-cooling-loop-requirements-rev-2-pdf`, licence: 'unknown', status: 'accepted', docType: 'requirements' },
  { id: 'l-lcdu-wp@1.0', family: 'liquid', title: 'Liquid to Liquid CDU Test Methodology and Performance Rating (white paper)', version: 'Rev 1.0', date: '2024', url: `${DOCS}ocp-wp-l-lcdu-test-methodology-performance-rating-r1-pdf`, licence: 'cc-by-sa-4.0', status: 'accepted', docType: 'white-paper', notes: 'Row / rack CDU rating basis (5 K approach, 1.5 LPM/kW).' },
  { id: 'modular-tcs-wp@dlm1', family: 'liquid', title: 'Modular TCS @ CloudScale: Design, Delivery and Selection Guidance (white paper)', version: 'DLM1', date: '', url: `${DOCS}ocp-wp-submittal-modular-tcs-at-cloudscale-design-delivery-selection-guidance-dlm1-docx-pdf`, licence: 'cc-by-sa-4.0', status: 'accepted', docType: 'white-paper' },
  { id: 'deschutes@0.80.0', family: 'liquid', title: 'Project Deschutes Data Center Facilities Specification', version: 'v0.80.0', date: '2025-07-01', url: `${DOCS}ocp-specification-deschutes-final-2025-09-05-pdf`, licence: 'owfa-0.9-mod', status: 'draft', docType: 'design-spec' },
  // ── air ──
  { id: 'door-hx-reqs@1.0', family: 'air', title: 'ACS Door Heat Exchanger Requirements for Open Rack', version: 'Rev 1.0', date: '2021-06-15', url: `${DOCS}acs-door-hx-open-compute-requirements-for-open-rack-rev1-0-1-pdf`, licence: 'all-rights-reserved', status: 'accepted', docType: 'requirements', notes: 'Facts and numbers only.' },
  { id: 'ashrae-tc99-liquid@cited', family: 'air', title: 'ASHRAE TC9.9 liquid cooling classes (as cited in cooling guidance)', version: 'cited', date: '', url: 'https://www.opencompute.org/wiki/Cooling_Environments', licence: 'proprietary', status: 'external', docType: 'industry-standard' },
  // ── compute / nic ──
  { id: 'oam-base@2.0-1.0', family: 'compute', title: 'OAI-OAM Base Specification', version: 'r2.0 v1.0', date: '2023-09-14', url: `${DOCS}oai-oam-base-specification-r2-0-v1-0-20230919-pdf`, licence: 'owfa-1.0', status: 'accepted', docType: 'base-spec', notes: 'Module power envelope 1000 W (P0); generic DLC node capped at it.' },
  { id: 'ubb-base@2.0-1.0', family: 'compute', title: 'OAI-UBB Base Specification', version: 'r2.0 v1.0', date: '2023-09-14', url: `${DOCS}oai-ubb-base-specification-r2-0-v1-0-20230919-pdf`, licence: 'owfa-1.0', status: 'accepted', docType: 'base-spec' },
  { id: 'nic3@1.6.0', family: 'nic', title: 'NIC 3.0 Design Specification', version: 'v1.6.0', date: '2025-03-31', url: `${DOCS}ocp-nic-3-0-r1v60-20250410a-tn-no-cb-pdf`, licence: 'hw-permissive', status: 'accepted', docType: 'design-spec' },
  // ── network / mgmt ──
  { id: 'opg-m@1.0', family: 'network', title: 'OPG-M System Architecture', version: 'v1.0', date: '2026-01-14', url: `${DOCS}opg-m-system-architecture-final-14-january-2026-pdf`, licence: 'cc-by-sa-4.0', status: 'accepted', docType: 'white-paper', notes: 'Facts only; connection maps and port tables are never shipped as data.' },
  { id: 'xoc-n@1.0', family: 'network', title: 'XOC-N System Architecture', version: 'v1.0', date: '2026-01-14', url: `${DOCS}xoc-n-system-architecture-final-14-january-2026-pdf`, licence: 'cc-by-sa-4.0', status: 'accepted', docType: 'white-paper' },
  { id: 'ualink-200g@1.0', family: 'network', title: 'UALink 200G Specification', version: '1.0', date: '2025-04-08', url: 'https://ualinkconsortium.org/specification/', licence: 'proprietary', status: 'external', docType: 'consortium-spec' },
  { id: 'uec@1.0', family: 'network', title: 'Ultra Ethernet Specification', version: '1.0', date: '2025-06-11', url: 'https://ultraethernet.org/ultra-ethernet-consortium-uec-launches-specification-1-0-transforming-ethernet-for-ai-and-hpc-at-scale/', licence: 'proprietary', status: 'external', docType: 'consortium-spec' },
  { id: 'hwmgmt-profiles@2026-09-01', family: 'mgmt', title: 'HWMgmt Redfish profiles (CDU, RDHx, power shelf, rack PDU, RMC, NIC)', version: 'commit 2026-09-01', date: '2026-09-01', url: 'https://github.com/opencomputeproject/HWMgmt-OCP-Profiles', licence: 'unknown', status: 'accepted', docType: 'guideline' },
  // ── facility (informational pre-check basis only) ──
  { id: 'facility-v1@1.5', family: 'facility', title: 'OCP Ready v1 data center facility assessment', version: 'v1.0 rev 1.5', date: '2026-06-30', url: 'https://github.com/opencomputeproject/OCP-Ready-Facility-Recognition-Program', licence: 'cc-by-4.0', status: 'accepted', docType: 'assessment', notes: 'Informational pre-check only; never an assessment or certification claim.' },
  { id: 'facility-v2hs@1.15', family: 'facility', title: 'OCP Ready v2 for Hyperscale facility assessment', version: 'rev 1.15', date: '2026-06-24', url: 'https://github.com/opencomputeproject/OCP-Ready-Facility-Recognition-Program', licence: 'cc-by-4.0', status: 'accepted', docType: 'assessment', notes: 'Informational pre-check only; never an assessment or certification claim.' },
  // P6 provenance guard: CL-14 reports the heat-reuse temperature band (< 20 / 20–45 / > 45 °C) of this reference design (research S12)
  { id: 'heat-reuse-rd@1.0', family: 'facility', title: 'Reference Designs for Data Center Heat Reuse', version: 'rev 1.0', date: '2025-03', url: `${DOCS}2025-03-18-ocp-heatreuse-wp-referencedesigns-v0-1-pdf`, licence: 'cc-by-sa-4.0', status: 'accepted', docType: 'white-paper', notes: 'Temperature bands only (facts); no tables or text reproduced (ShareAlike).' },
  // ── stream B (P2) additions: documents cited by the building-block seeds (catalog/seeds/std-*.ts) ──
  { id: 'hpr-psu-5.5kw@0.4', family: 'rack-power', title: 'ORv3 HPR 5.5 kW PSU Specification', version: 'Rev 0.4', date: '', url: RACK_WIKI, licence: 'owfa-1.0', status: 'draft', docType: 'design-spec' },
  { id: 'hpr-ac-whip@0.1', family: 'rack-power', title: 'ORv3 HPR AC Whip', version: 'Rev 0.1', date: '', url: RACK_WIKI, licence: 'owfa-1.0', status: 'draft', docType: 'design-spec' },
  { id: 'orv3-ac-whip@1.0', family: 'rack-power', title: 'Open Rack V3 AC Whip', version: 'Rev 1.0', date: '2022-05', url: RACK_WIKI, licence: 'unknown', status: 'accepted', docType: 'design-spec' },
  { id: 'orv3-pmi@1.0', family: 'mgmt', title: 'Open Rack V3 Power Management Interface', version: 'Rev 1.0', date: '', url: RACK_WIKI, licence: 'unknown', status: 'accepted', docType: 'design-spec' },
  { id: 'hpr-pmm@0.5.0', family: 'mgmt', title: 'ORv3 HPR Power Monitoring Module', version: 'Rev 0.5.0', date: '', url: RACK_WIKI, licence: 'unknown', status: 'draft', docType: 'design-spec' },
  { id: 'pg25-guideline@2022', family: 'liquid', title: 'Guidelines for Using Propylene Glycol-Based Heat Transfer Fluids in Single-Phase Cold Plate-Based Liquid Cooled Racks', version: '2022', date: '2022', url: `${DOCS}guidelines-for-using-propylene-glycol-based-heat-transfer-fluids-in-single-phase-cold-plate-based-liquid-cooled-racks-final-pdf`, licence: 'cc-by-sa-4.0', status: 'accepted', docType: 'guideline' },
  { id: 'water-coolant-guideline@2022', family: 'liquid', title: 'Guidelines for Using Water-Based Transfer Fluids in Single-Phase Cold Plate-Based Liquid Cooled Racks', version: '2022', date: '2022', url: `${DOCS}guidelines-for-using-water-based-transfer-fluids-in-single-phase-cold-plate-based-liquid-cooled-racks-final-pdf`, licence: 'cc-by-sa-4.0', status: 'accepted', docType: 'guideline' },
  { id: 'pg25-base@1.0.0', family: 'liquid', title: 'PG 25 Base Specification', version: 'V1.0.0', date: '2026-07-14', url: 'https://www.opencompute.org/wiki/Cooling_Environments/Cold_Plate', licence: 'owfa-0.9-mod', status: 'accepted', docType: 'base-spec', notes: 'Headline values only (full pass pending).' },
  { id: 'water-coolant-base@1.3', family: 'liquid', title: 'Water-Based Cold Plate Coolant Base Specification', version: 'V1.3', date: '2026-08-06', url: 'https://www.opencompute.org/wiki/Cooling_Environments/Cold_Plate', licence: 'owfa-0.9-mod', status: 'accepted', docType: 'base-spec', notes: 'Headline values only (full pass pending).' },
  { id: 'coolant-30c-wp@1.0', family: 'liquid', title: '30 °C Coolant: A Durable Roadmap for the Future (white paper)', version: 'Rev 1.0', date: '2024-10-01', url: `${DOCS}30-coolant-a-durable-roadmap-for-the-future-rev1-0-pdf`, licence: 'cc-by-sa-4.0', status: 'accepted', docType: 'white-paper' },
  { id: 'door-hx-wp@2023', family: 'air', title: 'ACS Door Heat Exchanger (white paper)', version: '2023', date: '2023', url: `${DOCS}acs-door-hx-whitepaper-final-230419-pdf`, licence: 'cc-by-sa-4.0', status: 'accepted', docType: 'white-paper' },
  { id: 'gpu-mgmt-interfaces@1.1', family: 'mgmt', title: 'GPU & Accelerator Management Interfaces', version: 'v1.1', date: '', url: `${DOCS}ocp-gpu-accelerator-management-interfaces-v1-1-pdf`, licence: 'unknown', status: 'accepted', docType: 'requirements', notes: 'Treats 8-GPU vendor baseboards as UBB-class devices (management scope only).' },
  { id: 'sai@1.19.0', family: 'network', title: 'Switch Abstraction Interface (SAI)', version: 'v1.19.0', date: '', url: 'https://github.com/opencomputeproject/SAI', licence: 'unknown', status: 'accepted', docType: 'guideline', notes: 'Support per switch SKU is not verified.' },
  { id: 'open-cluster-wp@1.0', family: 'network', title: 'White Paper: Open Cluster Designs for AI', version: 'v1.0', date: '2026-01-14', url: `${DOCS}white-paper-open-cluster-designs-for-ai-final-14-january-2026-pdf`, licence: 'cc-by-sa-4.0', status: 'accepted', docType: 'white-paper' },
  { id: 'training-fabric-ra@2026-08-23', family: 'network', title: 'AI training fabric reference architecture (repository)', version: 'commit 2026-08-23', date: '2026-08-23', url: 'https://github.com/opencomputeproject/OCP-OCDAI-training-fabric', licence: 'unknown', status: 'contributed', docType: 'guideline', notes: 'Secondary check only; pod sizes 64/256/512 exist only here.' },
  // ── vendor publications used for inference (not standards) ──
  { id: 'vendor-rackscale-orv3-width@2024-10-15', family: 'rack', title: 'NVIDIA technical blog: GB200 NVL72 designs contributed (ORv3 width, deeper 1,400 A busbar)', version: 'blog', date: '2024-10-15', url: 'https://developer.nvidia.com/blog/nvidia-contributes-nvidia-gb200-nvl72-designs-to-open-compute-project/', licence: 'proprietary', status: 'contributed', docType: 'vendor-publication', notes: 'Acceptance unverified; GB300 inheritance unverified.' },
];

const BY_ID = new Map(STANDARDS_REGISTRY.map((s) => [s.id, s]));

export function findStandard(id: string): StandardRef | undefined {
  return BY_ID.get(id);
}

export function standardsByFamily(family: StandardFamily): StandardRef[] {
  return STANDARDS_REGISTRY.filter((s) => s.family === family);
}

/** Draft-like statuses (hidden behind `includeDraftSpecs`, checks warning-capped). */
export const DRAFT_STATUSES = ['draft', 'review', 'roadmap'] as const;
export const isDraftStatus = (s: StandardRef['status']): boolean => (DRAFT_STATUSES as readonly string[]).includes(s);

/** Weakest status of a set of registry ids (unknown ids count as `roadmap`). Order: accepted > external > contributed > review > draft > roadmap. */
export function weakestStatus(ids: readonly string[]): StandardRef['status'] | undefined {
  const order: StandardRef['status'][] = ['accepted', 'external', 'contributed', 'review', 'draft', 'roadmap'];
  let worst = -1;
  for (const id of ids) worst = Math.max(worst, order.indexOf(findStandard(id)?.status ?? 'roadmap'));
  return worst < 0 ? undefined : order[worst];
}

/**
 * Citation label for UI legends / design documents: "title version". Satisfies the OWFa attribution condition (spec name +
 * version). Callers add wording like "based on … parameters" — never compliance or certification language.
 */
export function standardCitation(id: string): string {
  const s = findStandard(id);
  return s ? `${s.title} ${s.version}` : id;
}

// ───────────────────────────── presets (proposal §2.2) ─────────────────────────────

const ADVISORY = { strictness: 'advisory' as const, includeDraftSpecs: false };

export const STANDARDS_PRESETS: Readonly<Record<StandardsPresetId, StandardsProfile>> = {
  'orv3-hpr-liquid': {
    id: 'orv3-hpr-liquid', rackForm: 'orv3-hpr', rackPower: 'dc-busbar-50v-hpr', shelfClass: 'hpr-33kw', bbu: 'in-rack',
    liquid: { connector: 'bmqc', rackManifold: 'orv3-blindmate', cduClass: 'row-l2l', cduRatingBasis: 'l-lcdu-wp-r1', fluid: 'pg25' },
    air: 'crah-perimeter', facilityPrecheck: 'facility-v2hs@1.15', ...ADVISORY,
    pinned: {
      rack: ['orv3-base@1.1', 'orv3-frame-meta@1.3'],
      'rack-power': ['orv3-hpr-shelf-33kw@0.3', 'orv3-hpr-bbu-shelf-33kw@0.5'],
      liquid: ['orv3-bmqc@1.0', 'orv3-bm-manifold@1.0', 'l-lcdu-wp@1.0', 'deschutes@0.80.0'],
      compute: ['oam-base@2.0-1.0', 'ubb-base@2.0-1.0'],
      facility: ['facility-v2hs@1.15'],
    },
  },
  'orw-liquid-sidecar': {
    id: 'orw-liquid-sidecar', rackForm: 'orw', rackPower: 'hvdc-pm400-sidecar', bbu: 'none',
    liquid: { connector: 'bmqc', rackManifold: 'orv3-blindmate', cduClass: 'facility-2mw', cduRatingBasis: 'vendor', fluid: 'pg25' },
    air: 'fan-wall', facilityPrecheck: 'facility-v2hs@1.15', ...ADVISORY,
    pinned: { rack: ['orw-base@1.0.0', 'orw-meta-design@1.0.0'], 'rack-power': ['diablo400@0.7.0'], liquid: ['deschutes@0.80.0'], facility: ['facility-v2hs@1.15'] },
  },
  'orv3-air-dhx': {
    id: 'orv3-air-dhx', rackForm: 'orv3', rackPower: 'dc-busbar-48-54v', shelfClass: 'orv3-18kw', bbu: 'in-rack',
    liquid: { connector: 'none', rackManifold: 'none', cduClass: 'in-rack-rpu', fluid: 'treated-water', fwsClass: 'W17' },
    air: 'door-hx', facilityPrecheck: 'facility-v1@1.5', ...ADVISORY,
    pinned: {
      rack: ['orv3-base@1.1', 'orv3-frame-meta@1.3'],
      'rack-power': ['orv3-psu-48v@1.0', 'orv3-bbu-shelf@1.1', 'orv3-bbu-module@1.4', 'orv3-output-connector@2.0'],
      liquid: ['rpu@1.0'],
      air: ['door-hx-reqs@1.0'],
      facility: ['facility-v1@1.5'],
    },
  },
  'eia-air': {
    id: 'eia-air', rackForm: 'eia-310-19', rackPower: 'ac-pdu', bbu: 'none',
    liquid: { connector: 'none', rackManifold: 'none', cduClass: 'none', fluid: 'treated-water' },
    air: 'crah-perimeter', facilityPrecheck: 'facility-v1@1.5', ...ADVISORY,
    pinned: { rack: ['eia-310@e'], facility: ['facility-v1@1.5'] },
  },
  'eia-liquid-uqd': {
    id: 'eia-liquid-uqd', rackForm: 'eia-310-19', rackPower: 'ac-pdu', bbu: 'none',
    liquid: { connector: 'uqd', rackManifold: 'eia-vertical', cduClass: 'row-l2l', cduRatingBasis: 'l-lcdu-wp-r1', fluid: 'pg25' },
    air: 'crah-perimeter', facilityPrecheck: 'facility-v1@1.5', ...ADVISORY,
    pinned: { rack: ['eia-310@e'], liquid: ['uqd@1.0', 'uqdb@1.0', 'rack-manifold-wp@2023', 'l-lcdu-wp@1.0'], facility: ['facility-v1@1.5'] },
  },
};

export const STANDARDS_PRESET_IDS = Object.keys(STANDARDS_PRESETS) as StandardsPresetId[];

/** A fresh (mutable) copy of a preset. */
export function standardsPreset(id: StandardsPresetId): StandardsProfile {
  return structuredClone(STANDARDS_PRESETS[id]) as StandardsProfile;
}

/**
 * P0 defaults for the neutral reference (proposal "P0 impacts" box), with provenance. Engines / seeds / reference read
 * these instead of repeating literals. Values are parameters, never document text.
 */
export const NEUTRAL_REFERENCE_BASIS = {
  /** one frame implementation for footprint and ratings */
  frame: { standardId: 'orv3-frame-meta@1.3', widthMm: 600, depthMm: 1068, heightUnits: 44, unitPitchMm: 48, payloadKg: 1400, payloadExcludesFrame: true, crossBraceAboveKg: 800, itShelfKgPerSet: 80, verification: 'verified' as const },
  /** generic DLC node archetype: module power capped at the OAM r2.0 envelope; rack kW recomputed and estimate-tagged */
  dlcNode: { standardId: 'oam-base@2.0-1.0', modules: 8, moduleCapW: 1000, maxHeightUnits: 6, ownRailsAboveShelfLimit: true, verification: 'estimate' as const },
  /** HPR v1 power zone: 3 × 1 OU PSU shelves + 3 × 2 OU BBU shelves */
  hprPowerZoneUnits: 9,
  /** ORv3 BBU module: end-of-life threshold used by PW-06; beginning-of-life value shown as info */
  bbu: { standardId: 'orv3-bbu-module@1.4', eolBackupS: 90, bolBackupS: 240, verification: 'verified' as const },
  /** drafts toggle: these stay hidden unless `includeDraftSpecs` */
  behindDraftsToggle: ['hpr-v2-shelf-72kw@1.0'],
  /** adopted rule ids for other streams */
  adoptedRules: ['RK-03', 'CL-15', 'CL-16', 'PW-06'],
} as const;
