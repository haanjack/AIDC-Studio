import type { Locale } from '../model/types.ts';

/** Sheet vocabulary (deliverable language follows project.locale — DECISIONS-v2 #10). */
const STRINGS = {
  systemsTitle: { en: 'Ventilation / Power / Network systems', ko: '공조 · 전력 · 네트워크 시스템' },
  planTitle: { en: 'Floor & rack plan', ko: '상면 · 랙 배치 평면도' },
  elevationTitle: { en: 'Rack elevations', ko: '랙 입면도 (U-map)' },
  isoTitle: { en: 'Systems — exploded isometric', ko: '시스템 분해 등각 투영도' },
  company: { en: 'Company', ko: '회사' },
  owner: { en: 'Owner / contact', ko: '담당 / 연락처' },
  client: { en: 'Client', ko: '발주처' },
  projectNo: { en: 'Project no.', ko: '프로젝트 번호' },
  keyPlan: { en: 'Key plan', ko: '키 플랜' },
  projectName: { en: 'Project', ko: '프로젝트' },
  projectAddress: { en: 'Project address', ko: '프로젝트 주소' },
  stage: { en: 'Stage', ko: '단계' },
  stageValue: { en: 'Design coordination', ko: '설계 조정' },
  zoneKeyPlan: { en: 'Zones of intervention', ko: '공사 구역 키 플랜' },
  phase: { en: 'Phase', ko: '공사 단계' },
  discipline: { en: 'Discipline', ko: '분야' },
  sheetNo: { en: 'Sheet', ko: '시트 번호' },
  sheetTitle: { en: 'Sheet title', ko: '시트 제목' },
  modelFile: { en: 'Model file', ko: '모델 파일' },
  date: { en: 'Date', ko: '날짜' },
  drawnBy: { en: 'Drawn by', ko: '작성' },
  scale: { en: 'Scale', ko: '축척' },
  legendSystems: { en: 'Systems — operating state per construction phase', ko: '시스템 — 공사 단계별 운전 상태' },
  legendSystem: { en: 'System', ko: '시스템' },
  operational: { en: 'Operational', ko: '운전 중' },
  stopped: { en: 'Temporarily stopped (tie-in)', ko: '일시 정지 (연결 공사)' },
  na: { en: 'Not yet installed', ko: '미설치' },
  existing: { en: 'Existing elements', ko: '기존 요소' },
  newCommon: { en: 'New elements common to several systems', ko: '여러 시스템에 공통인 신규 요소' },
  layerPlenum: { en: 'Ceiling plenum', ko: '천장 플레넘' },
  layerOverhead: { en: 'Overhead', ko: '오버헤드' },
  layerFloor: { en: 'Floor', ko: '바닥' },
  layerUnderfloor: { en: 'Underfloor', ko: '이중마루 하부' },
  legend: { en: 'Legend', ko: '범례' },
  standardsBasis: { en: 'Standards basis', ko: '표준 기반' },
  gpuRack: { en: 'GPU rack', ko: 'GPU 랙' },
  cpuRack: { en: 'CPU rack', ko: 'CPU 랙' },
  storageRack: { en: 'Storage rack', ko: '스토리지 랙' },
  networkRack: { en: 'Network rack', ko: '네트워크 랙' },
  mgmtRack: { en: 'Management rack', ko: '관리 랙' },
  crah: { en: 'CRAH / fan wall', ko: 'CRAH / 팬월' },
  cdu: { en: 'CDU', ko: 'CDU' },
  containment: { en: 'Aisle containment', ko: '복도 컨테인먼트' },
  keepout: { en: 'Keep-out (column / door / egress)', ko: '금지 구역 (기둥 / 문 / 피난)' },
  tray: { en: 'Cable tray', ko: '케이블 트레이' },
  busway: { en: 'Busway A / B', ko: '버스웨이 A / B' },
  liquid: { en: 'TCS supply / return', ko: 'TCS 공급 / 환수' },
  frontTick: { en: 'Rack front (service side)', ko: '랙 전면 (서비스 측)' },
  servicesZone: { en: 'Services zone', ko: '서비스 구역' },
  zoneEndBand: { en: 'end band', ko: '끝 띠' },
  zoneCenterBand: { en: 'centre band', ko: '중앙 띠' },
  zoneSupportHac: { en: 'support HAC per design unit', ko: '설계 단위별 서포트 HAC' },
  zoneSeparateRoom: { en: 'separate room', ko: '별실' },
  reserve: { en: 'Reserve', ko: '예비' },
  reservePositions: { en: 'positions', ko: '자리' },
  reserveLegend: { en: 'Reserve / expansion positions', ko: '예비 · 증설 자리' },
  zoneLegend: { en: 'Services-zone boundary', ko: '서비스 구역 경계' },
  roomPartition: { en: 'Room partition', ko: '별실 칸막이' },
  overall: { en: 'Overall', ko: '전체' },
  podPitch: { en: 'Pod pitch', ko: '포드 피치' },
  hotAisle: { en: 'Hot aisle', ko: '열복도' },
  coldAisle: { en: 'Cold aisle', ko: '냉복도' },
  north: { en: 'N', ko: 'N' },
  hall: { en: 'Hall', ko: '홀' },
  grid: { en: 'Grid', ko: '그리드' },
  racks: { en: 'racks', ko: '랙' },
  gpus: { en: 'GPUs', ko: 'GPU' },
  wave: { en: 'Wave', ko: '웨이브' },
  allWaves: { en: 'All waves', ko: '전체 웨이브' },
  disciplineMech: { en: 'Mechanical / Electrical / Network', ko: '기계 / 전기 / 네트워크' },
  disciplineArch: { en: 'Architecture / IT layout', ko: '건축 / IT 배치' },
  disciplineIt: { en: 'IT / Network', ko: 'IT / 네트워크' },
  rackType: { en: 'Rack type', ko: '랙 종류' },
  instances: { en: 'instances', ko: '대' },
  similar: { en: 'similar', ko: '동일' },
  computeTray: { en: 'Compute tray', ko: '컴퓨트 트레이' },
  switchTray: { en: 'Scale-up switch tray', ko: '스케일업 스위치 트레이' },
  powerShelf: { en: 'Power shelf', ko: '파워 셸프' },
  mgmtUnit: { en: 'Management / RMC', ko: '관리 / RMC' },
  server: { en: 'Server', ko: '서버' },
  storageShelf: { en: 'Storage shelf', ko: '스토리지 셸프' },
  controller: { en: 'Controller', ko: '컨트롤러' },
  patchPanel: { en: 'Patch panel', ko: '패치 패널' },
  pdu: { en: 'PDU (0U)', ko: 'PDU (0U)' },
  blank: { en: 'Blanking panel', ko: '블랭킹 패널' },
  leaf: { en: 'Leaf', ko: '리프' },
  spine: { en: 'Spine', ko: '스파인' },
  core: { en: 'Core', ko: '코어' },
  mgmt: { en: 'Mgmt', ko: '관리' },
  cableChannel: { en: 'Cable channel', ko: '케이블 채널' },
  front: { en: 'FRONT', ko: '전면' },
  returnAir: { en: 'Hot-aisle return / plenum', ko: '열복도 환기 / 플레넘' },
  supplyAir: { en: 'Supply air (CRAH)', ko: '급기 (CRAH)' },
  cduSupply: { en: 'CDU liquid supply', ko: 'CDU 냉각수 공급' },
  cduReturn: { en: 'CDU liquid return', ko: 'CDU 냉각수 환수' },
  buswayA: { en: 'Busway A', ko: '버스웨이 A' },
  buswayB: { en: 'Busway B', ko: '버스웨이 B' },
  traysScaleOut: { en: 'Scale-out trays', ko: '스케일아웃 트레이' },
  frontend: { en: 'Front-end network', ko: '프런트엔드 네트워크' },
  storageNet: { en: 'Storage network', ko: '스토리지 네트워크' },
  oob: { en: 'OOB / management', ko: 'OOB / 관리' },
  envelope: { en: 'Building envelope (ghosted)', ko: '건물 외피 (반투명)' },
  ghostRacks: { en: 'Racks (ghost)', ko: '랙 (반투명)' },
  level: { en: 'Level', ko: '레벨' },
  underfloorSupply: { en: 'Underfloor supply plenum', ko: '이중마루 하부 급기 플레넘' },
  sheetOf: { en: 'of', ko: '/' },
} as const;

export type StrKey = keyof typeof STRINGS;

export function tr(locale: Locale, key: StrKey): string {
  const s = STRINGS[key];
  return locale === 'ko' ? s.ko : s.en;
}

export function fmtDate(iso: string | undefined, locale: Locale): string {
  const d = (iso ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return '—';
  return locale === 'ko' ? d.replace(/-/g, '.') : d;
}

/**
 * Generated device vocabulary on KO sheets (finish m5): slot models, switch roles / fabrics and status words come from the layout
 * engine in English; product names (catalog models) and slot codes (CT07, NVS3, PS-A2) stay as they are.
 */
const DEVICE_KO: readonly [RegExp, string | ((substring: string, ...args: any[]) => string)][] = [
  // QA backlog drawings: U-map source notes generated by layout/rackContents.ts (whole sentences first, before the word rules below);
  // KO sheets showed "U-map은 계획용 추정치 — no switch placement analysis". Product / document names stay.
  [/\bno switch placement analysis\b/g, '스위치 배치 분석 없음'],
  [/\bswitches from the network placement analysis \(top-down, role then model\)/g, '네트워크 배치 분석의 스위치 (위에서부터, 역할 → 모델 순)'],
  [/\bU-map is a planning estimate\b/g, 'U-map은 계획용 추정치'],
  [/\bU-map from the rack composer \(explicit U positions\)/g, '랙 구성기 U-map (명시된 U 위치)'],
  [/\brack composition \(DGX GB user guide\) — (\d+) compute trays, (\d+) NVLink switch trays, (\d+) power shelves; U order is an AIDC Studio layout/g, '랙 구성 (DGX GB user guide) — 컴퓨트 트레이 $1개, NVLink 스위치 트레이 $2개, 파워 셸프 $3개; U 순서는 AIDC Studio 배치'],
  [/\bslide (\d+) \((\d+) \+ (\d+) trays announced; power block OU split estimated from the render\)/g, '슬라이드 $1 (트레이 $2 + $3개 발표; 전원 블록 OU 분할은 렌더에서 추정)'],
  [/\bplanning estimate — generic (\S+) stack \(no public rack map\): (\d+)(?: of (\d+))? × (\d+)U (trays|nodes) of (\d+) × (.+?) in (\d+)(\w+)$/g, (_m: string, fam: string, fit: string, nodes: string | undefined, ru: string, kind: string, per: string, chip: string, tot: string, unit: string) => `계획용 추정 — 일반 ${fam} 구성 (공개 랙 맵 없음): ${fit}${nodes ? `/${nodes}` : ''} × ${ru}U ${kind === 'trays' ? '트레이' : '노드'} (${per} × ${chip}), 총 ${tot}${unit}`],
  [/\bplanning estimate — (\d+) × (\d+)U (\d+)-GPU nodes\b/g, '계획용 추정 — $1 × $2U $3-GPU 노드'],
  [/\bManagement switch position \(not in network analysis\)/g, '관리 스위치 자리 (네트워크 분석 미포함)'],
  [/\bManagement position\b/g, '관리 자리'],
  [/\bScale-up switch tray\b/gi, '스케일업 스위치 트레이'],
  [/\bNVLink switch tray\b/g, 'NVLink 스위치 트레이'],
  [/\bCompute tray\b/gi, '컴퓨트 트레이'],
  [/\bPower shelf\b/gi, '파워 셸프'],
  [/\bRack stiffener \/ top spacer\b/g, '랙 보강재 / 상부 스페이서'],
  [/\bRack stiffener\b/g, '랙 보강재'],
  [/\bCPU server\b/g, 'CPU 서버'],
  [/\bManagement server\b/g, '관리 서버'],
  [/\bStorage node\b/g, '스토리지 노드'],
  [/\bStorage controller\b/g, '스토리지 컨트롤러'],
  [/\bStorage shelf\b/g, '스토리지 셸프'],
  [/\bGPU server\b/g, 'GPU 서버'],
  [/\bPatch panel\b/gi, '패치 패널'],
  [/\bCable manager\b/gi, '케이블 매니저'],
  [/\bBlanking panel\b/gi, '블랭킹 패널'],
  [/\bReserved\b/g, '예약'],
  [/\bnode\b/g, '노드'],
  [/\btray\b/g, '트레이'],
  [/\bscale-out\b/g, '스케일아웃'],
  [/\bfrontend\b/g, '프런트엔드'],
  [/\bfront-end\b/g, '프런트엔드'],
  [/\bstorage\b/g, '스토리지'],
  [/\boob\b/g, 'OOB'],
  [/\bleaf\b/g, '리프'],
  [/\bspine\b/g, '스파인'],
  [/\bsuper-spine\b/g, '슈퍼스파인'],
  [/\bcore\b/g, '코어'],
  [/\bmgmt\b/g, '관리'],
];

/** Translate generated device / category / role words for the sheet locale (EN unchanged). */
export function deviceWords(locale: Locale, s: string): string {
  if (locale !== 'ko' || !s) return s;
  let out = s;
  for (const [re, ko] of DEVICE_KO) out = typeof ko === 'string' ? out.replace(re, ko) : out.replace(re, ko);
  return out;
}
