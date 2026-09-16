// Stream E (P5): display labels for standards-profile keys, chips and statuses (OCP-DESIGN-PROPOSAL §6.2).
//
// One source for deliverables (design document, BOM, drawings) and for the web UI namespace `standards` (the web locale files
// build their dictionaries from this table, so UI and deliverables never drift). Dependency-free data.
//
// Wording rules (proposal §6.2, trademark guidelines v1.7): chips and labels never use the organisation's mark, never say
// compliant / certified, and internal enum keys (e.g. level `open-spec`) are never shown — only these labels.
import type { Locale } from '../model/types.ts';

export type StdLabel = { en: string; ko: string };

/** Flat label table keyed `<kind>.<value>`. */
export const STANDARDS_LABELS = {
  // ── rack form (neutral names, DO-5) ──
  'rackForm.eia-310-19': { en: '19-inch EIA-310 racks', ko: '19인치 EIA-310 랙' },
  'rackForm.orv3': { en: '21-inch OU racks', ko: '21인치 OU 랙' },
  'rackForm.orv3-hpr': { en: 'High-power 21-inch OU racks', ko: '고전력 21인치 OU 랙' },
  'rackForm.orv3-mgx': { en: '21-inch-wide rack-scale frame (vendor design)', ko: '21인치 폭 랙 스케일 프레임 (벤더 설계)' },
  'rackForm.orw': { en: 'Wide OU racks', ko: '와이드 OU 랙' },
  'rackForm.mixed': { en: 'Mixed rack forms', ko: '혼합 랙 폼' },
  // ── rack power ──
  'rackPower.ac-pdu': { en: 'AC rack PDUs', ko: 'AC 랙 PDU' },
  'rackPower.dc-busbar-48-54v': { en: '48–54 V DC busbar with power shelves', ko: '48–54 V DC 버스바 + 전원 셸프' },
  'rackPower.dc-busbar-50v-hpr': { en: '50 V high-power DC busbar with power shelves', ko: '50 V 고전력 DC 버스바 + 전원 셸프' },
  'rackPower.hvdc-pm400-sidecar': { en: '±400 VDC sidecar power rack', ko: '±400 VDC 사이드카 전원 랙' },
  'rackPower.vendor-busbar': { en: 'Vendor rack busbar', ko: '벤더 랙 버스바' },
  // ── rack power interface declared by catalog items (catalog filter) ──
  'rackPowerInterface.ac-pdu': { en: 'AC rack PDUs', ko: 'AC 랙 PDU' },
  'rackPowerInterface.dc-busbar': { en: 'DC busbar', ko: 'DC 버스바' },
  'rackPowerInterface.hvdc-cable': { en: '±400 VDC cable feed', ko: '±400 VDC 케이블 급전' },
  // ── power shelf class ──
  'shelfClass.orv3-18kw': { en: '18 kW power shelf', ko: '18 kW 전원 셸프' },
  'shelfClass.hpr-33kw': { en: '33 kW high-power shelf', ko: '33 kW 고전력 셸프' },
  'shelfClass.hpr-v2-72kw': { en: '72 kW shelf (power-rack busbar only)', ko: '72 kW 셸프 (전원 랙 버스바 전용)' },
  'shelfClass.none': { en: 'Not set', ko: '지정 안 함' },
  // ── BBU ──
  'bbu.none': { en: 'No rack BBU', ko: '랙 BBU 없음' },
  'bbu.in-rack': { en: 'In-rack BBU shelves', ko: '랙 내 BBU 셸프' },
  // ── liquid ──
  'connector.uqd': { en: 'UQD quick disconnects', ko: 'UQD 퀵 디스커넥트' },
  'connector.uqdb': { en: 'UQDB blind-mate disconnects', ko: 'UQDB 블라인드메이트 디스커넥트' },
  'connector.bmqc': { en: 'Blind-mate quick connectors (BMQC)', ko: '블라인드메이트 퀵 커넥터 (BMQC)' },
  'connector.pbmc': { en: 'PBMC blind-mate connectors', ko: 'PBMC 블라인드메이트 커넥터' },
  'connector.lqc': { en: 'Large quick connectors (LQC)', ko: '대구경 퀵 커넥터 (LQC)' },
  'connector.vendor': { en: 'Vendor connector', ko: '벤더 커넥터' },
  'connector.none': { en: 'None', ko: '없음' },
  'rackManifold.eia-vertical': { en: 'Vertical rack manifold (19-inch)', ko: '수직 랙 매니폴드 (19인치)' },
  'rackManifold.orv3-blindmate': { en: 'Blind-mate rack manifold (21-inch)', ko: '블라인드메이트 랙 매니폴드 (21인치)' },
  'rackManifold.vendor': { en: 'Vendor manifold', ko: '벤더 매니폴드' },
  'rackManifold.none': { en: 'None', ko: '없음' },
  'cduClass.none': { en: 'No CDU', ko: 'CDU 없음' },
  'cduClass.in-rack-rpu': { en: 'In-rack pump unit', ko: '랙 내 펌프 유닛' },
  'cduClass.row-l2l': { en: 'Row liquid-to-liquid CDU', ko: '행 단위 액체-액체 CDU' },
  'cduClass.facility-2mw': { en: 'Facility CDU (2 MW class)', ko: '시설 CDU (2 MW급)' },
  'cduClass.facility': { en: 'Facility CDU', ko: '시설 CDU' },
  'cduRatingBasis.l-lcdu-wp-r1': { en: 'Row CDU rating basis (5 K approach, 1.5 L/min per kW)', ko: '행 CDU 정격 기준 (접근온도 5 K, kW당 1.5 L/min)' },
  'cduRatingBasis.loop-reqs-4k': { en: 'Cold-plate loop basis (4 °C approach reported)', ko: '콜드플레이트 루프 기준 (접근온도 4 °C 보고)' },
  'cduRatingBasis.vendor': { en: 'Vendor rating', ko: '벤더 정격' },
  'cduRatingBasis.none': { en: 'Not set', ko: '지정 안 함' },
  'fluid.pg25': { en: 'PG25 (propylene glycol 25 %)', ko: 'PG25 (프로필렌글리콜 25 %)' },
  'fluid.treated-water': { en: 'Treated water', ko: '처리수' },
  'fluid.dielectric-1p': { en: 'Single-phase dielectric', ko: '단상 유전 냉매' },
  'fwsClass.none': { en: 'Not set', ko: '지정 안 함' },
  'fwsClass.W17': { en: 'W17', ko: 'W17' },
  'fwsClass.W27': { en: 'W27', ko: 'W27' },
  'fwsClass.W32': { en: 'W32', ko: 'W32' },
  'fwsClass.W40': { en: 'W40', ko: 'W40' },
  'fwsClass.W45': { en: 'W45', ko: 'W45' },
  'fwsClass.W+': { en: 'W+', ko: 'W+' },
  // ── air side ──
  'air.crah-perimeter': { en: 'Perimeter air handlers', ko: '외곽 공조기' },
  'air.fan-wall': { en: 'Fan walls', ko: '팬월' },
  'air.door-hx': { en: 'Rear-door heat exchangers', ko: '후면 도어 열교환기' },
  'air.in-row': { en: 'In-row air units', ko: '인로우 공조 유닛' },
  'air.none': { en: 'None', ko: '없음' },
  // ── facility pre-check ──
  'facilityPrecheck.off': { en: 'Off', ko: '끔' },
  'facilityPrecheck.facility-v1@1.5': { en: 'Informational pre-check, colocation assessment v1 rev 1.5 basis', ko: '정보용 사전점검, 코로케이션 평가표 v1 rev 1.5 기준' },
  'facilityPrecheck.facility-v2hs@1.15': { en: 'Informational pre-check, hyperscale assessment v2 rev 1.15 basis', ko: '정보용 사전점검, 하이퍼스케일 평가표 v2 rev 1.15 기준' },
  // ── strictness / drafts (DO-3, DO-4) ──
  'strictness.advisory': { en: 'Advisory', ko: '정보용' },
  'strictness.gate': { en: 'Design gate', ko: '설계 게이트' },
  'drafts.on': { en: 'Draft specs included', ko: '초안 사양 포함' },
  'drafts.off': { en: 'Draft specs hidden', ko: '초안 사양 숨김' },
  // ── presets (same wording as the new-project wizard) ──
  'preset.orv3-hpr-liquid': { en: 'High-power 21-inch OU racks, liquid-cooled', ko: '고전력 21인치 OU 랙, 액체냉각' },
  'preset.orw-liquid-sidecar': { en: 'Wide OU racks, liquid-cooled (±400 VDC sidecar option)', ko: '와이드 OU 랙, 액체냉각 (±400 VDC 사이드카 옵션)' },
  'preset.orv3-air-dhx': { en: '21-inch OU racks, air with door heat exchangers', ko: '21인치 OU 랙, 공랭 + 도어 열교환기' },
  'preset.eia-air': { en: '19-inch EIA racks, air-cooled', ko: '19인치 EIA 랙, 공랭' },
  'preset.eia-liquid-uqd': { en: '19-inch EIA racks, liquid-cooled (UQD manifolds)', ko: '19인치 EIA 랙, 액체냉각 (UQD 매니폴드)' },
  'preset.custom': { en: 'Custom profile', ko: '사용자 지정 프로필' },
  // ── document families ──
  'family.rack': { en: 'Rack', ko: '랙' },
  'family.rack-power': { en: 'Rack power', ko: '랙 전원' },
  'family.power': { en: 'Power', ko: '전원' },
  'family.liquid': { en: 'Liquid cooling', ko: '액체냉각' },
  'family.air': { en: 'Air side', ko: '공기측' },
  'family.compute': { en: 'Compute', ko: '컴퓨트' },
  'family.nic': { en: 'NIC', ko: 'NIC' },
  'family.network': { en: 'Network', ko: '네트워크' },
  'family.mgmt': { en: 'Management', ko: '관리' },
  'family.facility': { en: 'Facility', ko: '시설' },
  // ── item standards scope ──
  'scope.rack': { en: 'Rack', ko: '랙' },
  'scope.power': { en: 'Power', ko: '전원' },
  'scope.liquid': { en: 'Liquid', ko: '액체' },
  'scope.air': { en: 'Air', ko: '공기' },
  'scope.module': { en: 'Accelerator module', ko: '가속기 모듈' },
  'scope.baseboard': { en: 'Baseboard', ko: '베이스보드' },
  'scope.nic': { en: 'NIC', ko: 'NIC' },
  'scope.host': { en: 'Host', ko: '호스트' },
  'scope.network': { en: 'Network', ko: '네트워크' },
  'scope.mgmt': { en: 'Management', ko: '관리' },
  'scope.facility': { en: 'Facility', ko: '시설' },
  // ── document status (the "accepted" state reads "Published" so it is never confused with a certification mark) ──
  'status.accepted': { en: 'Published', ko: '발행' },
  'status.contributed': { en: 'Contributed', ko: '기여' },
  'status.draft': { en: 'Draft', ko: '초안' },
  'status.review': { en: 'In review', ko: '검토 중' },
  'status.roadmap': { en: 'Roadmap', ko: '로드맵' },
  'status.external': { en: 'External standard', ko: '외부 표준' },
  // ── verification ──
  'verification.verified': { en: 'Verified', ko: '확인됨' },
  'verification.derived': { en: 'Derived', ko: '산출' },
  'verification.estimate': { en: 'Estimate', ko: '추정' },
  'verification.unverified': { en: 'Unverified', ko: '미검증' },
  // ── implementation level chips (§6.2; internal level keys are never displayed) ──
  'level.open-spec': { en: 'Open standard-based', ko: '개방 표준 기반' },
  'level.contributed-design': { en: 'Contributed design', ko: '기여 설계' },
  'level.open-platform-host': { en: 'Standard rack host', ko: '표준 랙 탑재' },
  'level.eia': { en: 'EIA-310', ko: 'EIA-310' },
  'level.proprietary': { en: 'Proprietary', ko: '독자 규격' },
  'levelTip.open-spec': { en: 'Implements {doc} ({status}). Parameters from the published document; not a certification.', ko: '{doc} ({status})를 구현합니다. 공개 문서의 파라미터이며 인증이 아닙니다.' },
  'levelTip.contributed-design': { en: 'Vendor design contributed to a standards body ({doc}). Compute and scale-up remain proprietary.', ko: '표준 단체에 기여된 벤더 설계입니다 ({doc}). 컴퓨트와 스케일업은 독자 규격입니다.' },
  'levelTip.open-platform-host': { en: 'Proprietary compute on {doc}.', ko: '{doc} 위의 독자 컴퓨트입니다.' },
  'levelTip.eia': { en: 'Generic 19-inch rack equipment ({doc}).', ko: '일반 19인치 랙 장비입니다 ({doc}).' },
  'levelTip.proprietary': { en: 'Modelled as an opaque appliance (footprint, kW, cooling, ports).', ko: '불투명 장비로 모델링합니다 (면적, kW, 냉각, 포트).' },
  'chip.draft': { en: 'Draft spec', ko: '초안 사양' },
  'chip.draftTip': { en: 'Values may change; checks based on it are warnings at most.', ko: '값이 바뀔 수 있습니다. 이 문서 기반 점검은 최대 경고입니다.' },
  'chip.estimate': { en: 'Estimate', ko: '추정' },
  'chip.unverified': { en: 'Unverified', ko: '미검증' },
  // ── facility pre-check levels ──
  'facilityLevel.optimum': { en: 'Optimum', ko: '최적' },
  'facilityLevel.acceptable': { en: 'Acceptable', ko: '허용' },
  'facilityLevel.exception': { en: 'Exception', ko: '예외' },
  'facilityLevel.not-modelled': { en: 'Not modelled', ko: '모델 없음' },
  // ── check status ──
  'checkStatus.finding': { en: 'Finding', ko: '발견' },
  'checkStatus.pass': { en: 'Pass', ko: '통과' },
  'checkStatus.not-modelled': { en: 'Not modelled', ko: '모델 없음' },
  'basis.standard': { en: 'Cited document', ko: '인용 문서' },
  'basis.estimate': { en: 'Planner estimate', ko: '계획 추정' },
  'basis.user': { en: 'User value', ko: '사용자 값' },
  // ── licences (registry `licence`) ──
  'licence.owfa-0.9-mod': { en: 'OWFa 0.9 (modified)', ko: 'OWFa 0.9 (수정본)' },
  'licence.owfa-1.0': { en: 'OWFa 1.0', ko: 'OWFa 1.0' },
  'licence.owfa-1.0-mod': { en: 'OWFa 1.0 (modified)', ko: 'OWFa 1.0 (수정본)' },
  'licence.hw-permissive': { en: 'Hardware licence (permissive)', ko: '하드웨어 라이선스 (허용형)' },
  'licence.cc-by-4.0': { en: 'CC BY 4.0', ko: 'CC BY 4.0' },
  'licence.cc-by-sa-4.0': { en: 'CC BY-SA 4.0', ko: 'CC BY-SA 4.0' },
  'licence.all-rights-reserved': { en: 'All rights reserved (facts only)', ko: '저작권 보유 (사실만 인용)' },
  'licence.proprietary': { en: 'Paid standard', ko: '유료 표준' },
  'licence.unknown': { en: 'Not stated', ko: '명시 없음' },
} as const satisfies Record<string, StdLabel>;

export type StandardsLabelKey = keyof typeof STANDARDS_LABELS;

/** Label of `<kind>.<value>` in a locale; unknown keys fall back to the value itself (never an internal key prefix). */
export function stdLabel(locale: Locale, kind: string, value: string | undefined, params?: Record<string, string>): string {
  if (value === undefined) return '';
  const e = (STANDARDS_LABELS as Record<string, StdLabel>)[`${kind}.${value}`];
  const s = e ? e[locale] ?? e.en : value;
  return params ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? params[k] : m)) : s;
}

/** UI dictionary for the web namespace `standards` (keys `standards.<kind>.<value>`). */
export function standardsDictionary(locale: Locale): Record<string, string> {
  return Object.fromEntries(Object.entries(STANDARDS_LABELS).map(([k, v]) => [`standards.${k}`, v[locale]]));
}

/**
 * Non-affiliation notice (proposal §6.3, Trademark Usage Guidelines v1.7, 2026-02-15). The English text is the approved wording
 * from the proposal (final wording subject to legal review); the Korean text is a translation that keeps the marks in English.
 * Never add the licensee sentence ("used with the permission of …") — no permission exists.
 */
export const STANDARDS_NOTICE: Readonly<Record<Locale, string>> = {
  en: 'Parameters derived from Open Compute Project® publications as cited. OCP®, Open Compute®, Open Compute Project® and OCP Ready® are registered marks of the Open Compute Project Foundation. AIDC Studio and its outputs are not affiliated with, endorsed by or certified by the Open Compute Project Foundation.',
  ko: '파라미터는 인용한 Open Compute Project® 발행 문서에서 가져왔습니다. OCP®, Open Compute®, Open Compute Project®, OCP Ready®는 Open Compute Project Foundation의 등록 상표입니다. AIDC Studio와 그 산출물은 Open Compute Project Foundation과 제휴 관계가 없으며, 그 보증이나 인증을 받지 않았습니다.',
};
