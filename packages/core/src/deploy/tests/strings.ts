import type { Locale } from '../../model/types.ts';

/** Strings of the test-kit README (EN default, KO selectable). Commands, file names and code stay English. */
export const TESTKIT_EN = {
  title: (p: string) => `${p} — acceptance test kit`,
  intro: 'Scripts and a pytest skeleton to accept the cluster after installation. Stage scripts write raw output to logs/; pytest parses the logs and writes results/<run-id>/results.json. Every pass bar below carries its source type; checks without a credible published value are recorded, not passed or failed.',
  item: 'Item', value: 'Value', vendor: 'Accelerator', tool: 'Collective benchmark', gpusPerNode: 'GPUs per node', nic: 'Scale-out NICs per node', fabric: 'Fabric · load balancing', nodes: 'Compute nodes',
  stagesTitle: 'Stages and run order',
  runOrder: 'Run order 00 → 10 → 20 → 30 → 40 → 50 → 60 (run_all.sh). Complete node-level steps on one representative system first, then replicate (AMD acceptance guide). Scripts starting with "_" are run by hand. Lines marked "verify" use syntax not confirmed in a fetched document.',
  stage: 'Stage', proves: 'What it proves', scripts: 'Scripts', outputs: 'Outputs',
  stages: [
    { id: '00-inventory', proves: 'GPU / NIC counts, firmware, addresses and NIC↔GPU affinity match the plan', scripts: 'collect_inventory.sh · test_inventory.py', outputs: 'logs/inventory/<host>/' },
    { id: '10-links', proves: 'Cabling equals the cable schedule (LLDP), no errors during a soak, link flap tolerance', scripts: 'lldp_collect.sh · link_counters.sh · _link_flap.sh · test_links.py', outputs: 'logs/lldp/ · logs/links/' },
    { id: '20-rdma', proves: 'Per-rail RDMA bandwidth between leaf halves (perftest bisection)', scripts: 'perftest_pairs.sh · test_rdma.py', outputs: 'logs/rdma/' },
    { id: '30-collectives', proves: 'η measurement kit: single-leaf baseline and cross-spine collectives, alltoall', scripts: '_build.sh · eta_mpirun.sh · _eta_srun.sh · eta_calibrate.py · test_collectives.py', outputs: 'logs/collectives/*.log · results/<run>/eta.json' },
    { id: '40-node', proves: 'Node health (DCGM diag level 3 or AMD AGFHC / single-node RCCL)', scripts: 'node_diag.sh · test_node.py', outputs: 'logs/node/' },
    { id: '50-storage', proves: 'Parallel file system throughput and metadata rates', scripts: 'storage.sh · fio-seq.fio · test_storage.py', outputs: 'logs/storage/' },
    { id: '60-thermal-power', proves: 'Inlet temperatures and PSU power stay inside design limits under load', scripts: 'redfish_poll.sh · redfish_poll.py · test_thermal_power.py', outputs: 'logs/thermal-power/*.jsonl' },
  ],
  etaTitle: 'η measurement kit',
  etaIntro: (gpn: number) => `η is measured, not assumed: both runs use NCCL_TESTS_SPLIT="MOD ${gpn}" so each group has one GPU per node and communicates only over the inter-node network (nccl-tests README). NCCL_ALGO=Ring with NVLS / CollNet off keeps the run network-bound.`,
  etaScopeSingle: (n: number) => `Single-leaf baseline — ${n} nodes on one leaf of the first rail (inventory/hostfiles/single-leaf.txt): rings never leave the leaf, so the result is η_host.`,
  etaScopeCross: (n: number, groups: number) => `Cross-spine run — ${n} nodes, one per leaf / pod interleaved over ${groups} leaf groups (inventory/hostfiles/cross-spine.txt): every ring edge crosses the spine.`,
  etaFormula: (ideal: string) => `η_bus = plateau busbw (mean of the three largest sizes ≥ 1 GiB) ÷ (NIC Gb/s ÷ 8 = ${ideal} GB/s); η_fabric = η_bus(cross-spine) ÷ η_bus(single-leaf). The "# Avg bus bandwidth" footer is never used as η.`,
  etaPaste: 'Paste logs/collectives/all_reduce_single-leaf.log and all_reduce_cross-spine.log into the Network panel η calibration box, or run 30-collectives/eta_calibrate.py.',
  etaPlanes: 'Per-plane runs are optional (default: aggregate over all rails): restrict NCCL_IB_HCA to one plane\'s devices to measure one plane.',
  predIdeal: 'Nominal busbw (MOD split)', predSingle: 'Predicted single-leaf busbw', predCross: 'Predicted cross-spine busbw',
  acceptanceTitle: 'Acceptance thresholds',
  acceptanceIntro: 'AMD platforms use the AMD Customer Acceptance Guide values. NVIDIA publishes no public acceptance values, so the kit applies the assumption "tool-predicted busbw × 0.9" (nccl-tests flags runs below 0.9 × expected). Source types: measured-paper · vendor-claim · acceptance-threshold · standard · official-config · derived · estimate.',
  check: 'Check', bar: 'Pass bar', sourceType: 'Source type', source: 'Source',
  recordOnly: 'record only', noValue: 'no credible published value — recorded, not judged',
  sourcesTitle: 'Sources',
  sources: [
    ['nccl-tests README / PERFORMANCE.md', 'https://github.com/NVIDIA/nccl-tests'],
    ['rccl-tests', 'https://github.com/ROCm/rccl-tests'],
    ['NCCL environment variables', 'https://docs.nvidia.com/deeplearning/nccl/user-guide/docs/env.html'],
    ['perftest', 'https://github.com/linux-rdma/perftest'],
    ['AMD Customer Acceptance Guide', 'https://instinct.docs.amd.com/projects/system-acceptance/en/latest/'],
    ['AMD Cluster Validation Suite', 'https://rocm.docs.amd.com/projects/cvs/en/latest/how-to/run-cvs-tests.html'],
    ['NVIDIA DCGM diagnostics', 'https://docs.nvidia.com/datacenter/dcgm/latest/user-guide/dcgm-diagnostics.html'],
    ['NVIDIA Cabling Data Centers DU-10438', 'https://docs.nvidia.com/cabling-data-centers.pdf'],
    ['Linux mlx5 counters', 'https://docs.kernel.org/networking/device_drivers/ethernet/mellanox/mlx5/counters.html'],
    ['fio documentation', 'https://fio.readthedocs.io/en/latest/fio_doc.html'],
    ['IOR tutorial', 'https://ior.readthedocs.io/en/latest/userDoc/tutorial.html'],
    ['DMTF Redfish schemas', 'https://redfish.dmtf.org/schemas/v1/'],
    ['NCCL tests performance notes (busbw / algbw)', 'https://github.com/NVIDIA/nccl-tests/blob/master/doc/PERFORMANCE.md'],
  ] as [string, string][],
};

export type TestKitStrings = typeof TESTKIT_EN;

export const TESTKIT_KO: TestKitStrings = {
  title: (p) => `${p} — 인수 시험 키트`,
  intro: '설치 후 클러스터 인수를 위한 스크립트와 pytest 골격. 단계별 스크립트는 원시 출력을 logs/에 쓰고, pytest가 로그를 파싱해 results/<run-id>/results.json을 만든다. 아래 모든 합격 기준에는 출처 유형이 붙어 있으며, 신뢰할 만한 공개 값이 없는 항목은 합격·불합격을 판정하지 않고 기록만 한다.',
  item: '항목', value: '값', vendor: '가속기', tool: '집합 통신 벤치마크', gpusPerNode: '노드당 GPU', nic: '노드당 스케일아웃 NIC', fabric: '패브릭 · 부하 분산', nodes: '컴퓨트 노드',
  stagesTitle: '단계와 실행 순서',
  runOrder: '실행 순서 00 → 10 → 20 → 30 → 40 → 50 → 60 (run_all.sh). 노드 단위 단계는 대표 시스템 1대에서 먼저 끝내고 복제한다(AMD 인수 가이드). "_"로 시작하는 스크립트는 수동 실행. "verify" 표시 줄은 가져온 문서에서 확인하지 못한 구문이다.',
  stage: '단계', proves: '검증 내용', scripts: '스크립트', outputs: '출력',
  stages: [
    { id: '00-inventory', proves: 'GPU / NIC 수, 펌웨어, 주소, NIC↔GPU 친화성이 계획과 일치', scripts: 'collect_inventory.sh · test_inventory.py', outputs: 'logs/inventory/<host>/' },
    { id: '10-links', proves: '케이블링이 케이블 스케줄과 일치(LLDP), 소크 중 오류 없음, 링크 플랩 내성', scripts: 'lldp_collect.sh · link_counters.sh · _link_flap.sh · test_links.py', outputs: 'logs/lldp/ · logs/links/' },
    { id: '20-rdma', proves: '리프 절반 사이 레일별 RDMA 대역폭(perftest 바이섹션)', scripts: 'perftest_pairs.sh · test_rdma.py', outputs: 'logs/rdma/' },
    { id: '30-collectives', proves: 'η 측정 키트: 단일 리프 기준 측정과 스파인 횡단 집합 통신, alltoall', scripts: '_build.sh · eta_mpirun.sh · _eta_srun.sh · eta_calibrate.py · test_collectives.py', outputs: 'logs/collectives/*.log · results/<run>/eta.json' },
    { id: '40-node', proves: '노드 상태(DCGM diag 레벨 3 또는 AMD AGFHC / 단일 노드 RCCL)', scripts: 'node_diag.sh · test_node.py', outputs: 'logs/node/' },
    { id: '50-storage', proves: '병렬 파일 시스템 처리량과 메타데이터 속도', scripts: 'storage.sh · fio-seq.fio · test_storage.py', outputs: 'logs/storage/' },
    { id: '60-thermal-power', proves: '부하 중 흡기 온도와 PSU 전력이 설계 한계 이내', scripts: 'redfish_poll.sh · redfish_poll.py · test_thermal_power.py', outputs: 'logs/thermal-power/*.jsonl' },
  ],
  etaTitle: 'η 측정 키트',
  etaIntro: (gpn) => `η는 가정이 아니라 측정한다: 두 실행 모두 NCCL_TESTS_SPLIT="MOD ${gpn}"을 사용해 그룹마다 노드당 GPU 1개만 참여하고 노드 간 네트워크로만 통신한다(nccl-tests README). NCCL_ALGO=Ring, NVLS / CollNet 끔으로 네트워크에 묶인 측정이 되게 한다.`,
  etaScopeSingle: (n) => `단일 리프 기준 측정 — 첫 레일의 한 리프에 연결된 노드 ${n}대(inventory/hostfiles/single-leaf.txt): 링이 리프를 벗어나지 않으므로 결과가 η_host다.`,
  etaScopeCross: (n, groups) => `스파인 횡단 측정 — 리프/포드마다 1대씩 교차 배열한 노드 ${n}대(리프 그룹 ${groups}개, inventory/hostfiles/cross-spine.txt): 모든 링 간선이 스파인을 지난다.`,
  etaFormula: (ideal) => `η_bus = 플래토 busbw(1 GiB 이상 가장 큰 3개 크기의 평균) ÷ (NIC Gb/s ÷ 8 = ${ideal} GB/s); η_fabric = η_bus(스파인 횡단) ÷ η_bus(단일 리프). "# Avg bus bandwidth" 푸터는 η로 쓰지 않는다.`,
  etaPaste: 'logs/collectives/all_reduce_single-leaf.log와 all_reduce_cross-spine.log를 네트워크 패널의 η 보정 입력란에 붙여넣거나 30-collectives/eta_calibrate.py를 실행한다.',
  etaPlanes: '평면별 측정은 선택(기본: 전체 레일 합산): 한 평면만 측정하려면 NCCL_IB_HCA를 그 평면의 장치로 제한한다.',
  predIdeal: '명목 busbw (MOD 분할)', predSingle: '예측 단일 리프 busbw', predCross: '예측 스파인 횡단 busbw',
  acceptanceTitle: '인수 기준',
  acceptanceIntro: 'AMD 플랫폼은 AMD Customer Acceptance Guide 값을 쓴다. NVIDIA는 공개 인수 값이 없어 "도구 예측 busbw × 0.9" 가정을 적용한다(nccl-tests도 기대값의 0.9 미만을 FAILED로 표시). 출처 유형: measured-paper · vendor-claim · acceptance-threshold · standard · official-config · derived · estimate.',
  check: '검사', bar: '합격 기준', sourceType: '출처 유형', source: '출처',
  recordOnly: '기록만', noValue: '신뢰할 만한 공개 값 없음 — 판정하지 않고 기록',
  sourcesTitle: '출처',
  sources: TESTKIT_EN.sources,
};

export function testKitStrings(locale: Locale = 'en'): TestKitStrings {
  return locale === 'ko' ? TESTKIT_KO : TESTKIT_EN;
}
