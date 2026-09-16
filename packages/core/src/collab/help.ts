// Built-in page help (stream T8): bilingual per-page explanations shown by the web help drawer AND indexed by the
// assistant's retrieval (ids `help:<page>`). Moved from apps/web/src/ui/HelpDrawer.tsx (S4) so the server can ground
// answers on the same text. Pure data — no numbers here feed the engines.
import type { Locale } from '../model/types.ts';

export type HelpPageId = 'overview' | 'workload' | 'architecture' | 'site' | 'layout' | 'power' | 'network' | 'cooling' | 'cost' | 'schedule' | 'drawings' | 'docs' | 'catalog';

type L = Record<Locale, string>;
export interface PageHelpDoc {
  title: L;
  computes: L;
  inputs: L[];
  terms: string[];
  tips?: L[];
}

export const HELP_PAGE_IDS: HelpPageId[] = ['overview', 'workload', 'architecture', 'site', 'layout', 'power', 'network', 'cooling', 'cost', 'schedule', 'drawings', 'docs', 'catalog'];

const l = (en: string, ko: string): L => ({ en, ko });

export const PAGE_HELP_DOCS: Record<HelpPageId, PageHelpDoc> = {
  overview: {
    title: l('Project overview', '프로젝트 개요'),
    computes: l(
      'A summary of every analysis engine: GPU count, IT/facility load, PUE, CAPEX/TCO, ready-for-service date (RFS) and validation issues on one screen. The utility and white-space headroom meters show required vs available (N−1 firm capacity).',
      '분석 엔진 전체 결과의 요약입니다. GPU 수, IT/시설 부하, PUE, CAPEX/TCO, 서비스 개시일(RFS)과 검증 이슈를 한 화면에 모읍니다. 수전·상면 여유 미터는 필요 대 가용(N−1 확정 용량) 비율입니다.',
    ),
    inputs: [l('Site utility feeders and hall IT power budget', '사이트 수전 피더와 홀 IT 전력 예산'), l('Placed equipment (racks, CDUs, switches)', '배치된 장비(랙·CDU·스위치)'), l('Workload blueprints', '워크로드 블루프린트')],
    terms: ['pue', 'capex-opex', 'rfs', 'n-1-feed', 'white-space', 'mfu', 'goodput', 'ttft', 'tpot'],
  },
  architecture: {
    title: l('Compute platform & design units', '컴퓨트 플랫폼 · 설계 단위'),
    computes: l(
      'Defines the compute design before floor planning: a catalog platform, its native scale-up domain, any cited reference-architecture unit, a vendor-neutral physical-interface template, hall-DU quantity and the initial scale-out topology. Compatible templates are checked from declared rack form, power, cooling and liquid-connector data.',
      '상면을 그리기 전에 컴퓨트 설계를 정의합니다. 카탈로그 플랫폼, 기본 scale-up 도메인, 인용 가능한 레퍼런스 아키텍처 단위, vendor 중립 물리 인터페이스 템플릿, 홀 DU 수량과 초기 scale-out 토폴로지를 구분합니다. 선언된 랙 폼·전력·냉각·액체 커넥터 데이터로 호환성을 확인합니다.',
    ),
    inputs: [
      l('Compute platform (NVIDIA, AMD, NPU or generic catalog rack)', '컴퓨트 플랫폼(NVIDIA·AMD·NPU·범용 카탈로그 랙)'),
      l('Physical template (rack envelope, row shape, containment and service interfaces)', '물리 템플릿(랙 외형, 열 구성, 컨테인먼트, 서비스 인터페이스)'),
      l('Repeat-unit count and initial scale-out topology', '반복 단위 수와 초기 스케일아웃 토폴로지'),
    ],
    terms: ['su', 'du', 'orv3', 'hac', 'rail-optimized', 'rack-plan', 'spec-source'],
    tips: [
      l('A catalog item is an asset/specification; a template is the placement and facility-interface rule that consumes it.', '카탈로그 항목은 자산·사양이고, 템플릿은 그 자산을 사용하는 배치·시설 인터페이스 규칙입니다.'),
      l('Vendor reference rows are clearly marked as estimates; the standard interface templates are the default path.', '벤더 레퍼런스 열은 추정으로 명시되며, 표준 인터페이스 템플릿이 기본 경로입니다.'),
      l('Never infer an SU from the scale-up domain size; an SU applies only when a cited reference architecture defines it.', 'Scale-up 도메인 크기로 SU를 추정하지 않습니다. SU는 인용한 레퍼런스 아키텍처가 정의한 경우에만 적용합니다.'),
    ],
  },
  site: {
    title: l('Site · utility · white space', '사이트 · 수전 · 상면'),
    computes: l(
      'Climate (design dry/wet bulb, economizer hours) and energy price feed the cooling and energy engines; utility feeders set the N−1 firm capacity and the energization constraint of the schedule. Hall dimensions, floor loading, IT power budget and cooling budget are the boundary conditions of the layout engine.',
      '기후(설계 건구/습구, 이코노마이저 시간)와 전력 단가는 냉각·에너지 엔진의 입력이고, 수전 피더는 N−1 확정 용량과 일정의 에너자이징 제약을 만듭니다. 홀 치수·하중·IT 전력 예산·냉각 예산은 배치 엔진의 경계 조건입니다.',
    ),
    inputs: [
      l('ASHRAE 0.4 % design outdoor conditions', 'ASHRAE 0.4 % 설계 외기'),
      l('Feeder voltage · MVA · substation · energization date', '피더 전압·MVA·변전소·공급 개시일'),
      l('Hall W×D, clear height, raised floor, floor loading, budgets', '홀 W×D, 천장고, 이중마루, 허용 하중, 예산'),
      l('Growth (phased / single-build), power profile (IEC / NEC / KR)', '증설 방식(phased / single-build), 전력 프로파일(IEC / NEC / KR)'),
    ],
    terms: ['n-1-feed', 'it-power-budget', 'cooling-budget', 'raised-floor', 'floor-load', 'growth', 'power-profile', 'keepout', 'economizer', 'ashrae-a'],
  },
  layout: {
    title: l('Equipment layout', '장비 배치'),
    computes: l(
      'The deployment-unit (DU) generator and its vendor-neutral templates place GPU rack rows, in-row CDUs, leaf/spine racks, containment and service rows. Fit-to-space finds the largest number of SUs within the power envelope, then the area; the spine placement comparator compares hall-end / centre / distributed candidates by optical run length and tray load.',
      '배포 단위(DU) 생성기와 벤더 중립 템플릿이 GPU 랙 열, 인로우 CDU, 리프/스파인 랙, 컨테인먼트, 서비스 열을 배치합니다. 상면 맞춤(fit-to-space)은 전력 범위 → 면적 순으로 최대 계획 단위 수를 찾고, 스파인 배치 비교기는 홀 끝/중앙/분산 후보의 광 경로 길이와 트레이 부하를 비교합니다.',
    ),
    inputs: [l('Compute platform and DU count', '컴퓨트 플랫폼과 DU 수'), l('Containment type (HAC/CAC)', '컨테인먼트 종류(HAC/CAC)'), l('Leaf/spine placement policy', '리프/스파인 배치 정책'), l('Corridor width profile', '복도 폭 프로파일')],
    terms: ['du', 'su', 'hac', 'cac', 'eor', 'tor', 'spine-placement', 'corridor', 'tray', 'mechanical-gallery', 'link-budget'],
    tips: [l('In the 3D view, Shift/Ctrl-click selects multiple modules; dragging any selected module moves the group, and R rotates it.', '3D 뷰에서 Shift/Ctrl+클릭으로 모듈을 다중 선택하고 선택된 모듈 하나를 드래그하면 그룹이 함께 이동하며, R 키로 함께 회전합니다.'), l('W/A/S/D pans horizontally in orbit mode and walks in walkthrough mode. F frames the camera on one selected item.', 'W/A/S/D는 궤도 모드에서 수평 이동하고 워크스루 모드에서 보행합니다. 하나를 선택한 뒤 F 키로 카메라를 맞춥니다.')],
  },
  power: {
    title: l('Power design', '전력 설계'),
    computes: l(
      'IT design load = nameplate × diversity factor + network. UPS, generators and transformers are counted from the redundancy rule (N, N+1, 2N, DR…) and the required capacity; RPPs/busways get per-pod A/B path loading. The one-line diagram follows utility → transformer → switchboard → UPS → distribution → load.',
      'IT 설계 부하 = 명판 × 다양성 계수 + 네트워크. UPS/발전기/변압기는 이중화 규칙(N, N+1, 2N, DR…)으로 대수와 필요 용량을 산정하고, RPP/버스웨이는 포드별 A/B 경로 부하율을 계산합니다. 단선결선도는 수전 → 변압기 → 배전반 → UPS → 분배 → 부하 경로입니다.',
    ),
    inputs: [
      l('Distribution voltage and method (busway / RPP)', '배전 전압·방식(버스웨이/RPP)'),
      l('Redundancy class', '이중화 등급'),
      l('Battery time, power factor, derating, diversity factor', '배터리 시간, 역률, 디레이팅, 다양성 계수'),
      l('Power smoothing (rack level / BESS)', '전력 평활화(랙 레벨 / BESS)'),
    ],
    terms: ['nameplate', 'diversity', 'derating', 'pf', 'ups-topology', 'tier', 'busway', 'rpp', 'pdu', 'edpp', 'power-smoothing', 'bess', 'one-line', 'ats'],
  },
  cooling: {
    title: l('Cooling · thermal simulation', '냉각 · 열 시뮬레이션'),
    computes: l(
      'Rack heat is split by liquid fraction into CDUs (TCS) and air (CRAH) to compute heat balance, flow and airflow, and chillers/dry coolers are sized. The CFD-lite solver computes the hall airflow and temperature field, reports rack inlet temperatures and RCI/RTI/SHI, and can be compared with a reference CFD result you import.',
      '랙 발열을 액체 비율로 CDU(TCS)와 공기(CRAH)로 나눠 열수지·유량·풍량을 계산하고 칠러/드라이쿨러를 산정합니다. CFD-lite 솔버는 홀의 기류·온도장을 풀어 랙 흡기 온도와 RCI/RTI/SHI를 보고하며 사용자가 가져온 레퍼런스 CFD 결과와 비교할 수 있습니다.',
    ),
    inputs: [
      l('FWS/TCS supply temperature, supply air temperature', 'FWS/TCS 공급 온도, 급기 온도'),
      l('Heat rejection method, economizer', '열 방출 방식, 이코노마이저'),
      l('CDU/CRAH/chiller models and redundancy', 'CDU/CRAH/칠러 모델과 이중화'),
      l('Grid size, IT load factor, containment/blanking overrides', '격자 크기, IT 부하율, 컨테인먼트/블랭킹 오버라이드'),
    ],
    terms: ['tcs', 'fws', 'cdu', 'crah', 'fan-wall', 'heat-capture', 'lpm-per-kw', 'ashrae-w', 'ashrae-a', 'rci', 'rti', 'shi', 'ppue', 'wue', 'cfd-lite', 'load-case'],
  },
  network: {
    title: l('Network · cabling', '네트워크 · 케이블링'),
    computes: l(
      'Scale-out, front-end, storage and OOB fabrics are sized from switch radix, oversubscription and rail count (leaf → spine → core); switches are placed in network racks and cable types, lengths and optics are computed. The traffic simulation turns the workload collectives into spine load and an L2/L3 recommendation.',
      '스케일아웃/프런트엔드/스토리지/OOB 패브릭을 스위치 radix·오버서브스크립션·레일 수로 산정(리프 → 스파인 → 코어), 스위치를 네트워크 랙에 배치하고 케이블 종류·길이·광모듈을 계산합니다. 트래픽 시뮬레이션은 워크로드의 집합 통신을 스파인 부하와 L2/L3 권고로 바꿉니다.',
    ),
    inputs: [
      l('Fabric technology (IB XDR, Spectrum-X, RoCE)', '패브릭 기술(IB XDR, Spectrum-X, RoCE)'),
      l('Topology (rail-optimized / fat tree), tier count, oversubscription', '토폴로지(레일 최적화/팻 트리), 계층 수, 오버서브스크립션'),
      l('Switch model, leaf/spine placement', '스위치 모델, 리프/스파인 배치'),
      l('Cable policy (copper limit, slack, route factor)', '케이블 정책(구리 한계, 여유, 경로계수)'),
    ],
    terms: ['oversubscription', 'undersubscription', 'rail-optimized', 'fat-tree', 'leaf', 'spine', 'core', 'tiers', 'radix', 'breakout', 'ecmp', 'ebgp', 'l3-fabric', 'ddc', 'dcqcn', 'pxn', 'sr8', 'dr8', 'dac', 'aec', 'link-budget'],
  },
  workload: {
    title: l('Workload blueprints', '워크로드 블루프린트'),
    computes: l(
      'Training: FLOPs = 6·N·D, TP/PP/DP/EP communication time, MFU, goodput (checkpoints · MTBI), days to train. Inference: prefill (compute-bound) and decode (HBM-bandwidth-bound) give TTFT/TPOT and the GPUs required. Both produce a power profile and energy (tokens/kWh).',
      '학습: FLOPs = 6·N·D, TP/PP/DP/EP 통신 시간, MFU, goodput(체크포인트·MTBI), 학습 소요일. 추론: prefill(연산 한계)과 decode(HBM 대역 한계)로 TTFT/TPOT와 필요 GPU 수. 두 경우 모두 전력 프로파일과 에너지(tokens/kWh)를 냅니다.',
    ),
    inputs: [l('Model size, token count, parallelism', '모델 크기, 토큰 수, 병렬화 구성'), l('Request rate, input/output length, SLO', '요청률, 입출력 길이, SLO'), l('Checkpoint interval, MTBI', '체크포인트 간격, MTBI')],
    terms: ['mfu', 'goodput', 'mtbi', 'checkpoint', 'parallelism', 'moe', 'all-reduce', 'busbw', 'ttft', 'tpot', 'kv-cache', 'prefill-decode', 'hbm', 'tokens-per-sec'],
  },
  cost: {
    title: l('BOM · cost', 'BOM · 비용'),
    computes: l(
      'CAPEX = catalog unit price × quantity + synthetic lines (batteries, piping, facility, labour, contingency); OPEX and 5-year TCO come from average-load energy plus maintenance. Source badges show how far a value can be trusted.',
      '카탈로그 단가 × 수량 + 합성 항목(배터리, 배관, 시설, 인건비, 예비비)으로 CAPEX를 만들고, 평균 부하 에너지 + 유지보수로 OPEX와 5년 TCO를 계산합니다. 출처 뱃지는 값의 신뢰 수준입니다.',
    ),
    inputs: [l('Currency · exchange rate, labour rate, construction unit cost, contingency', '통화·환율, 인건비, 공사비 단가, 예비비'), l('Price overrides (edit directly in the BOM table)', '단가 오버라이드(BOM 표에서 직접 수정)')],
    terms: ['bom', 'capex-opex', 'lead-time', 'spec-source', 'pue'],
  },
  schedule: {
    title: l('Quantities · installation schedule', '도입 수량 · 설치 일정'),
    computes: l(
      'Long-lead items are ordered at kick-off, durations come from work quantity / crew capacity, and CPM gives the critical path and the ready-for-service date (RFS). The cumulative GPU ramp per wave is shown as well.',
      '장납기 품목은 착수일 발주, 작업량/작업조 역량으로 기간을 산정하고 CPM으로 크리티컬 패스와 서비스 개시일(RFS)을 냅니다. 웨이브별 GPU 누적 램프도 보여줍니다.',
    ),
    inputs: [l('Start date, working days/hours, crews and crew size', '착수일, 작업일/시간, 작업조 수·인원'), l('Deployment waves (DU groups, target go-live)', '배포 웨이브(DU 묶음, 목표 가동일)'), l('Feeder energization date (energization constraint)', '피더 공급 개시일(에너자이징 제약)')],
    terms: ['wave', 'rfs', 'critical-path', 'lead-time', 'acceptance', 'du'],
  },
  docs: {
    title: l('Technical documents · export', '기술 문서 · 내보내기'),
    computes: l(
      'Generates the technical design document from the analysis (chapter order common to public vendor data-center design guides: brief → floor → layout & cooling → network → control plane → storage → power → resilience → BOM → deployment & acceptance) and exports the deployment bundle (BOM per wave, rack plan) and USD/Godot/Unreal/JSON. The language follows the Docs select in the top bar (project.locale).',
      '분석 결과로 기술 설계서(공개된 벤더 데이터센터 설계 가이드에 공통인 챕터 순서: 과제 → 바닥 → 배치·냉각 → 네트워크 → 컨트롤 플레인 → 스토리지 → 전력 → 회복력 → BOM → 배포·인수)를 생성하고, 배포 번들(웨이브별 BOM, 랙 플랜)과 USD/Godot/Unreal/JSON을 내보냅니다. 언어는 상단 문서 언어 드롭다운(project.locale)을 따릅니다.',
    ),
    inputs: [l('project.locale (EN default / KO)', 'project.locale (EN 기본 / KO)'), l('Design notes (free text per chapter)', '설계 노트(챕터별 자유 서술)'), l('Thermal simulation results (included when present)', '열 시뮬레이션 결과(있으면 문서에 포함)')],
    terms: ['bom', 'rack-plan', 'cable-schedule', 'ip-plan', 'digital-twin', 'simready', 'acceptance'],
  },
  catalog: {
    title: l('Equipment catalog', '장비 카탈로그'),
    computes: l(
      'The effective catalog = builtin ∪ server library ∪ project extensions. Check dimensions, power, cooling and cost specs and their sources for racks, switches, CDUs, CRAHs and power gear, and build new racks with the server → rack → interconnect composer.',
      '내장 카탈로그 ∪ 서버 라이브러리 ∪ 프로젝트 확장을 합친 유효 카탈로그입니다. 랙·스위치·CDU·CRAH·전력 설비의 치수·전력·냉각·비용 사양과 출처를 확인하고, 서버 → 랙 → 인터커넥트 컴포저로 새 랙을 만듭니다.',
    ),
    inputs: [l('Project extension items (catalogExtensions)', '프로젝트 확장 항목(catalogExtensions)'), l('Server-global library', '서버 전역 라이브러리')],
    terms: ['spec-source', 'simready', 'nvl72', 'hgx', 'helios', 'orv3', 'oam', 'scale-up', 'supernic', 'ru'],
  },
  drawings: {
    title: l('Drawing sheets', '도면 시트'),
    computes: l(
      'Generates white-space and rack plan blueprints (2D plan: rack tags, containment, CRAH/CDU, trays, dimension lines, grid bubbles) and per-system exploded isometric drawings as SVG for preview, download and print.',
      '상면·랙 플랜 블루프린트(2D 평면: 랙 태그, 컨테인먼트, CRAH/CDU, 트레이, 치수선, 그리드 버블)와 시스템별 등각 분해 도면을 SVG로 생성해 미리보기·다운로드·인쇄합니다.',
    ),
    inputs: [l('Title block (company · client · sheet number · author · scale)', '타이틀 블록(회사·클라이언트·시트 번호·작성자·축척)'), l('Systems shown and construction phase', '표시 시스템과 공사 단계')],
    terms: ['white-space', 'hac', 'tray', 'busway', 'mmr', 'rack-plan'],
  },
};

/** Plain-text rendering of one page's help in a locale (retrieval chunk + assistant fallback). */
export function pageHelpText(page: HelpPageId, locale: Locale): string {
  const h = PAGE_HELP_DOCS[page];
  const parts = [h.title[locale], h.computes[locale], h.inputs.map((x) => `- ${x[locale]}`).join('\n')];
  if (h.tips?.length) parts.push(h.tips.map((x) => `- ${x[locale]}`).join('\n'));
  return parts.join('\n');
}
