# AIDC Studio Product Guide

## Purpose

AIDC Studio treats an AI data centre as one connected engineering system. A change in compute platform, deployment-unit count, network fabric, power topology, cooling method, or delivery date propagates into the related capacity, space, cost, schedule, and document outputs.

The product is intended for feasibility studies, consulting, option comparison, concept design, coordinated layout development, and delivery planning. It is deliberately vendor-neutral: NVIDIA, AMD, and NPU systems are catalogued as alternative compute platforms rather than embedded as the product's architecture.

## Intended users

| User | Typical question | Primary workspaces |
|---|---|---|
| Infrastructure consultant | How many deployment units fit within the available power, floor, and schedule constraints? | Site, Overview, Layout, Schedule |
| Compute architect | Which platform and deployment-unit pattern satisfy the workload and scale-up requirements? | Architecture, Catalog, Workload |
| Network architect | Where are the rail, radix, cable-reach, oversubscription, or IP-plan bottlenecks? | Network, IP Map, Workload |
| Mechanical engineer | How are rack heat, liquid capture, room air, containment, and return-air paths coordinated? | Cooling & Thermal, Layout, Drawings |
| Electrical engineer | How do redundancy, voltage profile, distribution, and failure scenarios affect capacity? | Power, Site, Drawings |
| Commercial or programme lead | What are the CAPEX, TCO, procurement constraints, and ready-for-service date? | Cost, Schedule, Documents |
| Delivery team | What must be purchased, installed, configured, labelled, tested, and accepted? | Documents, Drawings, deployment bundle |

## End-to-end workflow

### 1. Establish the design basis

Create a project from the neutral reference, an empty site, or a vendor sample. Define:

- site climate, power cost, carbon factor, currency, and expansion strategy;
- utility feeders, capacity, substation, availability, and energisation date;
- hall envelope, clear height, return-plenum height, floor loading, IT-power budget, cooling budget, columns, and keepouts;
- electrical profile, target resilience tier, standards profile, and drawing units;
- project language and the provenance requirements for estimated or announced data.

The facility pre-check reports missing or inconsistent prerequisites. It is an engineering aid and does not claim facility certification.

### 2. Define compute and deployment units

The configuration hierarchy is intentionally explicit:

1. **Catalog item** — a component or deployable system with dimensions, interfaces, capacity, cost, and provenance.
2. **Compute platform** — the server, node, rack-scale system, or accelerator rack being deployed.
3. **Template** — the physical deployment pattern and its eligible compute slots.
4. **Deployment unit (DU)** — a generated project instance containing compute and support equipment.
5. **Hall and cluster** — the physical and network scope into which one or more DUs are placed.

Templates are grouped by physical interface and design pattern rather than by vendor. A template slot lists only registered compatible platforms. Mixed accelerator types belong in explicit template slots with a stated ratio or count.

A vendor-defined scalable unit remains vendor-specific. It can be represented as a reference template, but its rack count, support equipment, network domain, or scale-up boundary must not be copied into another platform without an engineering basis.

### 3. Generate and fit the hall

The layout generator places:

- compute rows, hot or cold aisle containment, and row-end clearances;
- support rows or support HACs;
- CDU, CRAH, fan-wall, in-row, RDHx, or liquid-to-air equipment;
- leaf, spine, core, front-end, storage, and OOB network racks;
- electrical rooms, RPPs, UPS support, reservations, and expansion positions;
- busways, tap-offs, cable trays, TCS pipe headers and branches, lighting, doors, walls, and penetrations.

Fit-to-space evaluates compatible template/platform combinations against an existing hall. Right-size can expand or contract a generated hall around its actual equipment and required clearances. Layout regeneration must recompute the hall footprint rather than preserve unused whitespace by default.

Validation covers hall boundaries, overlap, clearance, service access, wall penetration, capacity, cable reach, air throw, pipe equivalent length, and standard-profile constraints. Deterministic findings can offer one-click remedies.

### 4. Coordinate power

Power analysis includes:

- IT, network, mechanical, conversion-loss, and facility loads;
- diversity and utilisation;
- UPS, generator, transformer, RPP, busway, and tap-off sizing;
- IEC, NEC, and project-specific distribution-voltage profiles;
- N, N+1, N+2, 2N, 2N+1, distributed-redundant, and block-redundant patterns;
- physical A/B paths and a hall power one-line;
- utility, generator, UPS-module, RPP, busway, and load-factor scenarios;
- N-1 sweeps and Max-Q stranded-power checks.

The model supports planning and coordination. Detailed protection, short-circuit, arc-flash, harmonic, grounding, and authority studies remain outside its scope.

### 5. Coordinate cooling and airflow

Cooling analysis separates liquid-captured and room-air heat. It sizes CDU, room-air equipment, and heat rejection from the project design basis and reports flow, capacity, pPUE, and WUE.

Supported comparison concepts include perimeter CRAH, gallery fan wall, in-row cooling, rear-door heat exchangers, and liquid-to-air sidecars. Placement logic remains separate from the catalog so the same equipment class can be evaluated under different hall strategies.

CFD-lite uses rack heat and airflow, cooler supply and return boundaries, containment, solids, and optional ceiling plenum cells. It reports rack inlet/exhaust temperature, cooler return, RCI, RTI, SHI, convergence, and energy balance.

Return-air topology is explicit:

- **Common ceiling return plenum:** HAC chimneys discharge into the plenum; CRAHs draw through top return risers.
- **Direct room-top return:** no ceiling plenum is solved; CRAHs draw from the upper occupied volume.

The 3D overlay distinguishes supply air, HAC exhaust rise, and return route. This diagram expresses design intent; solved CFD particles express the computed field.

### 6. Design the network and IP plan

The network engine supports scale-up, scale-out, front-end, storage, OOB, and inter-hall fabrics. It determines tiers and switch counts from endpoint demand, switch radix, uplink policy, and oversubscription. It also supports:

- conventional and rail-oriented endpoint placement;
- leaf, spine, super-spine, core, and DDC-style roles;
- load-balancing class and effective efficiency as host × fabric efficiency;
- calibration from nccl-tests or rccl-tests output;
- workload-driven collective and point-to-point traffic;
- tray-aware or Manhattan cable routing, reach checks, and optics/cable BOM;
- port-level labels and cable schedules;
- per-hall or joined-cluster fabrics and inter-hall trunks.

The deterministic IP/ASN planner produces:

- IPv4 and IPv6 blocks by site, hall, fabric, role, DU, subnet, device, and NIC;
- `/31`, `/127`, loopback, management, and service allocations as applicable;
- private ASN assignments and BGP-oriented link addressing;
- utilisation and overlap findings;
- location, rail/fabric, subnet, device, NIC, and address review views;
- CSV, HTML, and deployment-bundle outputs.

Workload traffic can be overlaid on network topology to visualise hot links, loaded rails, oversubscribed tiers, and expected bottlenecks. The evaluator accepts a selected training or inference scenario; inference combines layout GPU racks with prefill/decode TP/PP/EP/CP and optional P/D KV-cache transfer rather than requiring a training job. Scale-up capacity and naming come from the primary GPU rack actually placed in Layout: for example, an AMD UBB8 result uses its Infinity Fabric domain while an HGX result uses NVLink. The UI distinguishes per-GPU demand from effective one-way capacity and shows the published bidirectional value and bus-bandwidth factor used to derive it. The bottleneck map presents scale-up and scale-out as separate fabrics—not consecutive hops—and identifies the configured InfiniBand, RoCE, Ethernet, or DDC fabric; an idle Leaf/NIC explicitly means that the selected parallel group never leaves its scale-up domain.

### 7. Model and validate workloads

Workload blueprints describe training, fine-tuning, and inference. The default simulation is cluster-first: the GPU-rack model carrying the most accelerators in the placed layout supplies physical HBM, the runtime-usable HBM limit, scale-up domain, compute throughput and bandwidth. Inputs then include model shape, precision, tokens, parallelism, communication, checkpointing, availability, and accelerator allocation. The engine estimates:

- compute and communication time;
- effective throughput and MFU;
- collective traffic and communication efficiency;
- goodput after failure and checkpoint overhead;
- training duration or inference capacity;
- accelerator, DU, MW, and floor-space demand;
- time-varying power profile.

Inference blueprints define TP, PP, EP, and CP per replica; DP is derived from the replica count required by demand. TP has a memory-fit floor based on per-GPU weight residency, one maximum-length KV sequence, selected precisions, and a runtime reserve. Request rate changes replica count rather than this floor. Aggregated serving uses one topology. Prefill/decode disaggregation may use different topologies for the two pools, so the calculation preserves separate replica sizes and counts and includes the inter-pool KV-transfer path. Dense-model EP, expert-count mismatches, and memory-minimum groups that leave the scale-up domain are reported explicitly. Backend workspace, fragmentation, throughput, and latency remain calibration inputs rather than claimed measurements.

Public model presets are starting points. Benchmark calibration should be used before treating results as project commitments.

For greenfield work, an optional reverse-sizing what-if can translate a workload target into a GPU, DU, MW, and floor-area proposal. The proposal is handed back to Platform & units for review; it does not change the current cluster or masquerade as a simulation of hardware that has not been placed.

### 8. Plan cost and schedule

Cost combines equipment, networking, cables and optics, power, cooling, facility allowances, labour, contingency, and configurable unit prices. Outputs include CAPEX, OPEX, TCO, and per-accelerator metrics.

Schedule combines procurement lead time, utility availability, construction and installation productivity, deployment waves, cabling, integration, and L1–L5 commissioning. It reports the critical path, ready-for-service constraint, and accelerator activation ramp.

### 9. Issue documents and deployment outputs

Available deliverables include:

- printable design report with embedded SVG diagrams;
- drawing index, key plan, plans, sections, elevations, MEP isometrics, row schematics, rack elevations, and one-lines;
- BOM, rack plan, rack contents, switch inventory, cable schedule, and IPv4/IPv6 plan in HTML/CSV;
- wave-specific deployment bundles;
- NOS configurations for supported operating systems;
- performance, storage, power, and thermal acceptance-test kits;
- project JSON, engine-neutral layout JSON, OpenUSD, glTF, Godot, and Unreal packages.

## User interface structure

The left navigation follows the default cluster-first delivery sequence:

1. Overview
2. Architecture and standards
3. Site
4. Layout
5. Workload
6. Power
7. Network and IP map
8. Cooling and thermal
9. Cost
10. Schedule
11. Drawings
12. Documents
13. Catalog

Catalog authoring supports the workflow but is not itself a delivery phase. Templates and compute platforms are configured from the architecture/layout flow and reuse catalog definitions. Workload retains an optional demand-first resize loop for greenfield studies, but all simulation results remain labelled with the placed hardware basis.

## Data provenance

Every decision-relevant value should carry an origin:

| Tag | Meaning |
|---|---|
| `public-spec` | Published product or standard value |
| `announced` | Publicly announced but not fully released or validated |
| `derived` | Calculated from cited inputs |
| `estimate` | Planning assumption requiring confirmation |
| `unverified` | Present for completeness but not suitable for a design gate |

The UI and generated documents expose these tags. Estimates, future-platform values, pricing, lead times, and vendor claims must not be presented as verified engineering facts.

## Modelling boundaries

- CFD-lite is for comparative planning and coordination, not final mechanical validation.
- Power analysis is for capacity and topology planning, not protection or safety studies.
- Network simulation is deterministic and workload-informed, but it does not replace emulation or production benchmarks.
- Cost and schedule values are planning estimates until replaced by quotations and an approved programme.
- Standards checks compare declared parameters; they do not confer OCP, Uptime, TIA, IEC, NEC, or other certification.
- Vendor sample projects demonstrate supported configurations and do not imply endorsement.

## Current priorities

- Deepen template and compute-platform authoring guidance and validation.
- Expand vendor-neutral NPU and future accelerator coverage while keeping public-spec and estimate boundaries explicit.
- Improve workload-to-network bottleneck visualisation and rail-oriented IPv6 review.
- Extend scenario comparison across layout, power, cooling, cost, and schedule.
- Continue improving drawing annotation density, section selection, paper composition, and print quality.
- Complete reproducible standalone packaging and signed release automation.

## Publication boundary

The public repository includes original source code, generated generic assets, required notices, and public-source references. It excludes live project data, vendor-supplied assets and documents, research captures, and legal-audit working papers. Run `node tools/licenses/check-publication.mjs` before publication or release packaging.
