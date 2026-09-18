export * from './model/types.ts';
export * from './model/geometry.ts';
export * from './catalog/catalog.ts';
export * from './catalog/registry.ts';
// stream A (P1): standards registry / profile, id + enum aliases, stored-project upgrade
export * from './standards/index.ts';
export * from './catalog/aliases.ts';
export * from './model/upgrade.ts';
export * from './catalog/seeds/index.ts';
export * from './catalog/dataChanges.ts'; // stream B (P2): intentional catalog value changes with a one-time notice
export * from './standards/data/facility-types.ts'; // stream B (P2): facility assessment thresholds as data
export * from './catalog/compose.ts';
export * from './layout/estimates.ts';
export * from './layout/generate.ts';
export * from './layout/reference.ts';
export * from './layout/rows.ts';
export * from './layout/geometry3d.ts'; // finish v2 2차 (D1): partitions, cable-run paths
export * from './engines/powerGeometry.ts'; // finish v2 2차 (D1): feeder routing + sleeves
export * from './layout/trunkSleeves.ts'; // finish v2 2차 (D5): inter-hall trunk sleeve positions
export * from './layout/wallAudit.ts'; // finish v2 2차 (D1): wall-piercing / clash audit
export * from './engines/interHall.ts'; // finish v2 2차 (D5): trunk pathways + network-side sleeves
export * from './layout/fit.ts';
export * from './layout/templates/index.ts';
export * from './layout/templates/eligibility.ts'; // stream D (P4): slot eligibility by declared standards, draft visibility, sidecar sizing
export * from './layout/samples/index.ts'; // stream D (P4): vendor sample projects ("NVIDIA reference")
export * from './engines/index.ts';
export * from './export/index.ts';
export * from './docs/index.ts';
// v2 contract modules (stubs until the streams land)
export * from './drawings/index.ts';
export * from './glossary/index.ts';
export * from './deploy/index.ts';
// v2 2차 contract modules (typed stubs until streams T1–T8 land; see docs/research/contract-v2-2.md)
export * from './layout/zones.ts';
export * from './layout/coolingPlacement.ts';
export * from './layout/grid.ts';
// D2: shared rack U-map resolver (drawings · rack plan · cable schedule · rack elevations)
export * from './layout/rackContents.ts';
// halls lifecycle (add / rename / duplicate / remove) + IP allocation map
export * from './layout/halls.ts';
export * from './engines/ipmap.ts';
// autosize v2 2차: auto-sized hall generation (engine-verified counts, budgets) + one-click issue remedies
export * from './layout/autosize.ts';
export * from './layout/remedies.ts';
export * from './workload/presets.ts';
export * from './workload/calibration.ts';
export * from './workload/shares.ts';
export * from './workload/inference.ts';
export * from './workload/inferencex.ts';
export * from './workload/inferencexRegression.ts';
export * from './catalog/images.ts';
export * from './catalog/assetManifest.ts';
export * from './catalog/flops.ts';
export * from './catalog/checks.ts'; // stream T4: coolant limit, announced badge, GPU/accelerator counts, registration records
export * from './docs/html.ts';
export * from './deploy/csv.ts';
export * from './deploy/html.ts';
export * from './deploy/nos/index.ts';
export * from './deploy/tests/index.ts';
// v2 2차 T8: collaboration (version diff) + assistant grounding (help corpus, BM25 retrieval, citations)
export * from './collab/index.ts';
// r4 contract: one geometry source (prims → projections → DrawList2D) + derived pipes (docs/research/contract-r4.md)
export * from './scene/index.ts';
export * from './layout/pipes.ts';
