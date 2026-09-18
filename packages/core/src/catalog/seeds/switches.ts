import type { CatalogItem } from '../../model/types.ts';

/**
 * Switch and NIC seeds (proposal §3.7): Broadcom TH5/TH6 generic boxes, DriveNets 2500S / 5300R / 9300F (AMD × DriveNets
 * RA Tables 5, 9, 10 — vendor-datasheet), Arista 7700R4C-38PE / 7720R4-128PE (AMD MI3XX RA power table — public-spec),
 * Arista 7060X6-64PE, Cisco Nexus 9364E-SG2, Dell Z9864F-ON, Juniper QFX5240-64OD (64 × 800G merchant/Silicon One boxes), and
 * NICs (ConnectX-7/8/9, AMD Pollara 400, Broadcom Thor2) as the new 'nic' category (never placed on the floor).
 *
 * FabricTech (aligned with S2's engines/network.ts): DriveNets 5300R / 9300F carry 'drivenets-fse' (DDC sizing reads
 * netPorts / fabricPorts), the 2500S and the generic TH5 carry 'ese-uec-400' as 128 × 400G logical ports (64 × OSFP800
 * physical — S2's ESE convention). The other 800G merchant boxes (TH6, Arista DES, Cisco, Dell, Juniper) carry
 * 'roce-generic-800' (integration v2; default switch `generic-roce-800`, a vendor-neutral TH5-class 64 × 800G box like
 * `generic-roce-400`); set `switch.fabric` to 'drivenets-fse' on the Arista DES boxes if a DDC design with them is wanted.
 */

const SW = (o: Partial<CatalogItem> & Pick<CatalogItem, 'id' | 'vendor' | 'model' | 'name' | 'description' | 'switch' | 'power' | 'cost' | 'source'>): CatalogItem => ({
  category: 'switch',
  dims: { w: 0.44, d: 0.66, h: 0.0445 * (o.switch?.rackUnits ?? 1) },
  weightKg: 12 * (o.switch?.rackUnits ?? 1),
  clearance: { front: 0, rear: 0, sides: 0 },
  cooling: { liquidFraction: 0, airflowM3s: 0.08 * (o.switch?.rackUnits ?? 1), liquidFlowLpm: 0, maxInletC: 35 },
  ...o,
});

export const SWITCH_CATALOG: CatalogItem[] = [
  SW({
    id: 'generic-roce-800', vendor: 'Generic', model: '51.2T 800G ×64', name: 'Generic 51.2T Ethernet (800GbE ×64)',
    description: 'Merchant-silicon 51.2 Tb/s Ethernet switch (Tomahawk 5 / Silicon One G200 class), 64 × 800G OSFP, 2RU, RoCEv2 with standard congestion control — default box of the roce-generic-800 fabric.',
    switch: { fabric: 'roce-generic-800', ports: 64, portGbps: 800, rackUnits: 2, role: 'any' },
    power: { nameplateKW: 2.2, typicalKW: 1.3, idleKW: 0.6, peakKW: 2.2, feeds: 2, voltageV: 230 },
    weightKg: 23, cost: { capexUSD: 85_000, installHours: 4, leadTimeWeeks: 12 }, source: 'estimate',
    notes: 'Class value for the 64 × 800G merchant boxes (Cisco N9364E-SG2, Dell Z9864F-ON, Juniper QFX5240-64OD): power 1.3 kW typical / 2.2 kW max without optics, price and lead time are estimates; mirrors generic-roce-400.',
  }),
  SW({
    id: 'broadcom-th5-64x800', vendor: 'Generic (Broadcom)', model: 'Tomahawk 5 64×800G', name: 'Generic Tomahawk 5 (800GbE ×64, 51.2T)',
    description: 'Merchant-silicon 51.2 Tb/s Ethernet switch on Broadcom Tomahawk 5 (BCM78900), 64 × 800G OSFP, 2RU, RoCEv2 — class representative (DriveNets 2500S, Dell Z9864F, Juniper QFX5240, Arista 7060X6…).',
    switch: { fabric: 'ese-uec-400', ports: 128, portGbps: 400, rackUnits: 2, role: 'any' },
    power: { nameplateKW: 1.7, typicalKW: 1.07, idleKW: 0.5, peakKW: 1.7, feeds: 2, voltageV: 230 },
    weightKg: 22, cost: { capexUSD: 80_000, installHours: 4, leadTimeWeeks: 12 }, source: 'estimate',
    notes: '64 × OSFP800 modelled as 128 × 400G logical ports (ESE convention, S2). Power = DriveNets 2500S (TH5) typical 1,066 W / max 1,684 W without optics as the class value. Add ~15–17 W per 800G optic.',
  }),
  SW({
    id: 'broadcom-th6-128x800', vendor: 'Generic (Broadcom)', model: 'Tomahawk 6 128×800G', name: 'Generic Tomahawk 6 (800GbE ×128, 102.4T)',
    description: 'Merchant-silicon 102.4 Tb/s Ethernet switch on Broadcom Tomahawk 6 (BCM78910), 128 × 800G (or 64 × 1.6T) OSFP, 4RU, air or liquid — class representative.',
    switch: { fabric: 'roce-generic-800', ports: 128, portGbps: 800, rackUnits: 4, role: 'any' },
    power: { nameplateKW: 4.0, typicalKW: 2.6, idleKW: 1.1, peakKW: 4.2, feeds: 2, voltageV: 230 },
    weightKg: 45, cost: { capexUSD: 180_000, installHours: 6, leadTimeWeeks: 20 }, source: 'estimate',
    notes: 'TH6 boxes are shipping in 2026 (SN6600 / Arista 7060X7 class); RU, power and price are estimates.',
  }),
  SW({
    id: 'drivenets-2500s', vendor: 'DriveNets', model: '2500S', name: 'DriveNets 2500S (ESE, 800G ×64, TH5)',
    description: 'Endpoint Scheduled Ethernet standalone leaf/spine/super-spine on Tomahawk 5 (BCM78900), 64 × OSFP800 (51.2T), 2RU 580 mm deep, 2 × 3,000 W PSU, 3+1 fans.',
    switch: { fabric: 'ese-uec-400', ports: 128, portGbps: 400, rackUnits: 2, role: 'any' },
    dims: { w: 0.44, d: 0.58, h: 0.087 },
    power: { nameplateKW: 1.684, typicalKW: 1.066, idleKW: 0.5, peakKW: 1.684, feeds: 2, voltageV: 230 },
    weightKg: 22, cost: { capexUSD: 90_000, installHours: 4, leadTimeWeeks: 14 }, source: 'vendor-datasheet',
    links: [{ label: 'DriveNets AI networking', url: 'https://drivenets.com/solutions/ai-networking/' }],
    notes: 'AMD × DriveNets RA Table 5: 64 × OSFP800 (51.2T) modelled as 128 × 400G logical ports (ESE convention, S2); 1,066 W typical / 1,684 W max (no optics), AC 200–240 V 16 A or DC −48 V 80 A. Weight, idle and price are estimates.',
  }),
  SW({
    id: 'drivenets-5300r', vendor: 'DriveNets', model: '5300R', name: 'DriveNets 5300R (FSE NCP leaf, 18 net + 20 fabric ×800G)',
    description: 'Fabric Scheduled Ethernet NCP (leaf) on Jericho3-AI (BCM88892): 18 × OSFP800 network ports + 20 × OSFP800 fabric ports (14.4T network), 2RU, 21 kg, 1+1 PSU, 3+1 fans; VOQ + cell spraying to 9300F NCFs.',
    switch: { fabric: 'drivenets-fse', ports: 38, portGbps: 800, rackUnits: 2, role: 'leaf', netPorts: 18, fabricPorts: 20 },
    dims: { w: 0.44, d: 0.6482, h: 0.087 },
    power: { nameplateKW: 1.14, typicalKW: 0.782, idleKW: 0.4, peakKW: 1.14, feeds: 2, voltageV: 230 },
    weightKg: 21, cost: { capexUSD: 75_000, installHours: 4, leadTimeWeeks: 14 }, source: 'vendor-datasheet',
    links: [{ label: 'DriveNets AI networking', url: 'https://drivenets.com/solutions/ai-networking/' }],
    notes: 'AMD × DriveNets RA Table 9: 782 W typical / 1,140 W max, 87 × 440 × 648.2 mm, 21 kg. DDC sizing: NCPs = ceil(endpoints800 / 18), NCFs = ceil(NCPs × 20 / 128). Price estimate.',
  }),
  SW({
    id: 'drivenets-9300f', vendor: 'DriveNets', model: '9300F', name: 'DriveNets 9300F (FSE NCF spine, 800G ×128)',
    description: 'Fabric Scheduled Ethernet NCF (fabric/spine, cluster only) on 2 × Ramon3 (BCM88920): 128 × OSFP800 (102.4T), 6RU, 63 kg, 2+1 PSU, 7+1 fans.',
    switch: { fabric: 'drivenets-fse', ports: 128, portGbps: 800, rackUnits: 6, role: 'spine', fabricPorts: 128 },
    dims: { w: 0.44, d: 0.6682, h: 0.263 },
    power: { nameplateKW: 1.918, typicalKW: 1.113, idleKW: 0.6, peakKW: 1.918, feeds: 3, voltageV: 230 },
    weightKg: 63, cost: { capexUSD: 220_000, installHours: 8, leadTimeWeeks: 16 }, source: 'vendor-datasheet',
    links: [{ label: 'DriveNets AI networking', url: 'https://drivenets.com/solutions/ai-networking/' }],
    notes: 'AMD × DriveNets RA Table 10: 1,113 W typical / 1,918 W max, 263 × 440 × 668.2 mm, 63 kg. Every NCP has one 400G link to every NCF → NCF racks are the most cable-dense point (7–10 racks for 8K GPUs). Price estimate.',
  }),
  SW({
    id: 'arista-7060x6-64pe', vendor: 'Arista', model: '7060X6-64PE', name: 'Arista 7060X6-64PE (800G ×64, 51.2T)',
    description: 'Arista fixed 51.2 Tb/s Ethernet switch, 64 × 800G OSFP, 2RU. It is an Ethernet/RoCEv2 option, not an InfiniBand Quantum replacement.',
    switch: { fabric: 'roce-generic-800', ports: 64, portGbps: 800, rackUnits: 2, role: 'any' },
    power: { nameplateKW: 2.2, typicalKW: 1.3, idleKW: 0.6, peakKW: 2.2, feeds: 2, voltageV: 230 },
    weightKg: 23, cost: { capexUSD: 90_000, installHours: 4, leadTimeWeeks: 14 }, source: 'public-spec',
    links: [{ label: 'Arista 7060X6 data sheet', url: 'https://www.arista.com/assets/data/pdf/Datasheets/7060X6-Datasheet.pdf' }],
    notes: '64 × 800G / 51.2T and RoCEv2 support are public specifications. Power, weight, price and lead time are planning estimates; validate 2 × 400G breakout optics and the chosen EOS congestion-control profile with the selected SKU.',
  }),
  SW({
    id: 'arista-7700r4c-38pe', vendor: 'Arista', model: '7700R4C-38PE', name: 'Arista 7700R4C-38PE (DES leaf, 800G ×38)',
    description: 'Arista Distributed Etherlink Switch leaf (Jericho3-AI class): 38 × 800G OSFP (18 network + 20 fabric), 2RU.',
    switch: { fabric: 'roce-generic-800', ports: 38, portGbps: 800, rackUnits: 2, role: 'leaf', netPorts: 18, fabricPorts: 20 },
    power: { nameplateKW: 1.84, typicalKW: 0.593, idleKW: 0.35, peakKW: 1.84, feeds: 2, voltageV: 230 },
    weightKg: 22, cost: { capexUSD: 85_000, installHours: 4, leadTimeWeeks: 14 }, source: 'public-spec',
    links: [{ label: 'Arista AI networking', url: 'https://www.arista.com/en/solutions/ai-networking' }],
    notes: 'Power 593 W typical / 1,840 W load per the AMD MI3XX Reference Design power table (scheduled-fabric design, 64 × 7700R4C). Port split assumed equal to the DriveNets 5300R class (18 + 20) — estimate. Price estimate.',
  }),
  SW({
    id: 'arista-7720r4-128pe', vendor: 'Arista', model: '7720R4-128PE', name: 'Arista 7720R4-128PE (DES spine, 800G ×128)',
    description: 'Arista Distributed Etherlink Switch spine (Ramon3 class): 128 × 800G OSFP, 6RU.',
    switch: { fabric: 'roce-generic-800', ports: 128, portGbps: 800, rackUnits: 6, role: 'spine' },
    power: { nameplateKW: 3.848, typicalKW: 1.032, idleKW: 0.6, peakKW: 3.848, feeds: 3, voltageV: 230 },
    weightKg: 65, cost: { capexUSD: 240_000, installHours: 8, leadTimeWeeks: 16 }, source: 'public-spec',
    links: [{ label: 'Arista AI networking', url: 'https://www.arista.com/en/solutions/ai-networking' }],
    notes: 'Power 1,032 W typical / 3,848 W load per the AMD MI3XX Reference Design power table (10 × 7720R4-128PE). RU, weight and price are estimates.',
  }),
  SW({
    id: 'cisco-n9364e-sg2', vendor: 'Cisco', model: 'Nexus 9364E-SG2', name: 'Cisco Nexus 9364E-SG2 (800G ×64, Silicon One G200)',
    description: 'Cisco Nexus 9300 series fixed switch on Silicon One G200, 64 × 800G OSFP (51.2T), 2RU, NX-OS / SONiC.',
    switch: { fabric: 'roce-generic-800', ports: 64, portGbps: 800, rackUnits: 2, role: 'any' },
    power: { nameplateKW: 2.2, typicalKW: 1.3, idleKW: 0.6, peakKW: 2.2, feeds: 2, voltageV: 230 },
    weightKg: 24, cost: { capexUSD: 95_000, installHours: 4, leadTimeWeeks: 14 }, source: 'public-spec',
    links: [{ label: 'Cisco Nexus 9364E-SG2 data sheet', url: 'https://www.cisco.com/c/en/us/products/collateral/switches/nexus-9000-series-switches/nexus-9364e-sg2-switch-ds.pdf' }],
    notes: '64 × 800G / 51.2T and Silicon One G200 are public specifications. Power, weight, price and lead time are planning estimates; validate the selected 400G breakout optic/cable SKU and NX-OS or SONiC RoCE configuration before construction.',
  }),
  SW({
    id: 'dell-z9864f-on', vendor: 'Dell', model: 'Z9864F-ON', name: 'Dell PowerSwitch Z9864F-ON (800G ×64, TH5)',
    description: 'Dell PowerSwitch on Tomahawk 5, 64 × 800G OSFP (51.2T), 2RU, Enterprise SONiC / OS10.',
    switch: { fabric: 'roce-generic-800', ports: 64, portGbps: 800, rackUnits: 2, role: 'any' },
    power: { nameplateKW: 1.8, typicalKW: 1.1, idleKW: 0.5, peakKW: 1.8, feeds: 2, voltageV: 230 },
    weightKg: 23, cost: { capexUSD: 80_000, installHours: 4, leadTimeWeeks: 12 }, source: 'public-spec',
    links: [{ label: 'Dell Z9864F-ON installation guide', url: 'https://www.dell.com/support/manuals/en-us/networking-z9864f-on/z9864f-on_install_pub/introduction?guid=guid-20cc9fe6-045e-4a3b-b5b9-78f4a818b22d&lang=en-us' }, { label: 'Dell AI switches', url: 'https://www.dell.com/en-us/shop/ai-switches/sf/ai-switches' }],
    notes: '64 × 800G / 51.2T and 400G breakout options are public product specifications; Dell lists RoCEv2 AI networking. Power, weight, price and lead time are planning estimates.',
  }),
  SW({
    id: 'juniper-qfx5240-64od', vendor: 'Juniper (HPE)', model: 'QFX5240-64OD', name: 'Juniper QFX5240-64OD (800G ×64, TH5)',
    description: 'Juniper QFX5240 on Tomahawk 5, 64 × 800G OSFP (51.2T), 2RU, Junos (Apstra-managed).',
    switch: { fabric: 'roce-generic-800', ports: 64, portGbps: 800, rackUnits: 2, role: 'any' },
    power: { nameplateKW: 1.8, typicalKW: 1.1, idleKW: 0.5, peakKW: 1.8, feeds: 2, voltageV: 230 },
    weightKg: 23, cost: { capexUSD: 85_000, installHours: 4, leadTimeWeeks: 12 }, source: 'public-spec',
    links: [{ label: 'Juniper QFX5240-64OD', url: 'https://www.juniper.net/gb/en/products/switches/qfx-series/qfx5240-data-center-switches.html' }],
    notes: '64 × 800G / 51.2T, 128 × 400G breakout and RoCEv2 are public specifications. Power, weight, price and lead time are planning estimates.',
  }),
];

const NIC = (o: Partial<CatalogItem> & Pick<CatalogItem, 'id' | 'vendor' | 'model' | 'name' | 'description' | 'nic' | 'cost' | 'source'>): CatalogItem => ({
  category: 'nic',
  dims: { w: 0.07, d: 0.17, h: 0.02 },
  weightKg: 0.3,
  clearance: { front: 0, rear: 0, sides: 0 },
  power: { nameplateKW: (o.nic?.wattsMax ?? 0) / 1000, typicalKW: (o.nic?.wattsTypical ?? 0) / 1000, idleKW: (o.nic?.wattsTypical ?? 0) / 2000, peakKW: (o.nic?.wattsMax ?? 0) / 1000, feeds: 0, voltageV: 12 },
  asset: { color: '#1f3b2b' },
  ...o,
});

export const NIC_CATALOG: CatalogItem[] = [
  NIC({
    id: 'nvidia-cx7-400', vendor: 'NVIDIA', model: 'ConnectX-7', name: 'ConnectX-7 (400G, 1 × OSFP)',
    description: 'NVIDIA ConnectX-7 400G adapter (NDR InfiniBand / 400GbE RoCE), PCIe Gen5 x16.',
    nic: { ports: 1, portGbps: 400, totalGbps: 400, formFactor: 'pcie-hhhl', hostInterface: 'PCIe Gen5 x16', transports: ['ib', 'roce'], wattsTypical: 24, wattsMax: 33 },
    cost: { capexUSD: 2_500, installHours: 0.2, leadTimeWeeks: 8 }, source: 'public-spec',
    notes: 'Validated for AMD MI300X/MI325X backend per the AMD cluster networking guide (not for MI350X/MI355X). Power typical/max from NVIDIA adapter datasheet class values.',
  }),
  NIC({
    id: 'nvidia-cx8-800', vendor: 'NVIDIA', model: 'ConnectX-8 SuperNIC', name: 'ConnectX-8 SuperNIC (800G)',
    description: 'NVIDIA ConnectX-8 SuperNIC, 800 Gb/s (XDR InfiniBand / Spectrum-X 800GbE), PCIe Gen6 x16, integrated PCIe switch.',
    nic: { ports: 1, portGbps: 800, totalGbps: 800, formFactor: 'pcie-fhhl', hostInterface: 'PCIe Gen6 x16', transports: ['ib', 'spectrum-x', 'roce'], wattsTypical: 35, wattsMax: 50 },
    cost: { capexUSD: 4_500, installHours: 0.2, leadTimeWeeks: 12 }, source: 'public-spec',
    notes: 'Speed / host interface public; power and price are estimates.',
  }),
  NIC({
    id: 'nvidia-cx9-1600', vendor: 'NVIDIA', model: 'ConnectX-9 SuperNIC', name: 'ConnectX-9 SuperNIC (1.6T, announced)',
    description: 'NVIDIA ConnectX-9 SuperNIC, 1.6 Tb/s (8 × 200G planes for Vera Rubin NVL72 Spectrum-X; 2 per compute-tray GPU pair), PCIe Gen6.',
    nic: { ports: 1, portGbps: 1600, totalGbps: 1600, formFactor: 'custom', hostInterface: 'PCIe Gen6 x16', transports: ['spectrum-x', 'ib'], wattsTypical: 45, wattsMax: 65 },
    cost: { capexUSD: 7_500, installHours: 0.2, leadTimeWeeks: 24 }, source: 'announced',
    notes: 'announced: ConnectX-9 SuperNIC, 1.6 Tb/s class, PCIe Gen6 (NVIDIA Vera Rubin announcements). estimate: the 8 × 200G plane split per GPU pair, NICs per tray, power and price.',
  }),
  NIC({
    id: 'amd-pollara-400', vendor: 'AMD (Pensando)', model: 'Pollara 400', name: 'AMD Pensando Pollara 400 AI NIC (400G, UEC-ready)',
    description: '400 Gb/s AI NIC, HHHL PCIe or OCP 3.0 TSFF, PCIe Gen5 x16, QSFP112 (1×400 / 2×200 / 4×100); UEC-ready, switch and NIC packet spray, in-order delivery, RoCEv2, SR-IOV.',
    nic: { ports: 1, portGbps: 400, totalGbps: 400, formFactor: 'pcie-hhhl', hostInterface: 'PCIe Gen5 x16', transports: ['uec', 'roce'], wattsTypical: 30, wattsMax: 40 },
    cost: { capexUSD: 2_200, installHours: 0.2, leadTimeWeeks: 10 }, source: 'public-spec',
    links: [{ label: 'AMD MI3XX Reference Design', url: 'https://instinct.docs.amd.com/projects/MI3XX-reference/latest/index.html' }],
    notes: 'AMD × DriveNets RA Tables 3–4; validated backend/frontend NIC for MI300X–MI355X. Power and price are estimates.',
  }),
  NIC({
    id: 'broadcom-thor2-400', vendor: 'Broadcom', model: 'BCM57608 Thor2', name: 'Broadcom Thor2 BCM57608 (400G)',
    description: '400 Gb/s aggregate Ethernet NIC (single/dual/quad port, 8 × 25/50/100G SerDes), PCIe Gen5 x16, RoCEv2, multi-host up to 4, inline kTLS/QUIC crypto.',
    nic: { ports: 1, portGbps: 400, totalGbps: 400, formFactor: 'pcie-hhhl', hostInterface: 'PCIe Gen5 x16', transports: ['roce'], wattsTypical: 25, wattsMax: 35 },
    cost: { capexUSD: 1_900, installHours: 0.2, leadTimeWeeks: 10 }, source: 'public-spec',
    notes: 'AMD × DriveNets RA p.17–18 (BCM957608 in the AMD MI3XX generic BOM). Power and price are estimates.',
  }),
];
