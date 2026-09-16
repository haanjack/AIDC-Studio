// Stream E (P5): "Standards basis" content shared by the design document, BOM exports and drawing title blocks
// (OCP-DESIGN-PROPOSAL §6.2–6.3).
//
// Rules: facts only (document title, version, date, status, licence, public URL from the registry); no specification text;
// internal enum keys are rendered through `STANDARDS_LABELS`; parameter checks are "parameter checks", never assessments,
// compliance or certification; the non-affiliation notice follows Trademark Usage Guidelines v1.7.
import { findCatalogItem } from '../catalog/catalog.ts';
import { buildContext } from '../engines/context.ts';
import { facilityPrecheck, facilityPrecheckBasis } from '../engines/facilityPrecheck.ts';
import type { CatalogItem, Hall, Issue, Locale, Project, ProjectAnalysis, StandardsCheckDetail } from '../model/types.ts';
import { findStandard, isDraftStatus, standardCitation } from '../standards/registry.ts';
import { effectiveStandardsProfile } from '../standards/profile.ts';
import type { StandardFamily, StandardRef, StandardsProfile, Verification } from '../standards/types.ts';
import type { DocBlock } from './index.ts';
import { STANDARDS_LABELS, STANDARDS_NOTICE, stdLabel } from './standardsLabels.ts';

const FAMILY_ORDER: StandardFamily[] = ['rack', 'rack-power', 'liquid', 'air', 'compute', 'nic', 'network', 'mgmt', 'facility'];
export const CHECK_FAMILY_ORDER: StandardsCheckDetail['family'][] = ['rack', 'power', 'liquid', 'air', 'compute', 'network', 'facility'];
const VERIFICATION_RANK: Verification[] = ['verified', 'derived', 'estimate', 'unverified'];

/** Preset id of a profile, or undefined for a custom / inferred profile without a matching preset. */
const presetLabel = (p: StandardsProfile, L: Locale) => stdLabel(L, 'preset', p.id && `preset.${p.id}` in STANDARDS_LABELS ? p.id : 'custom');

// ───────────────────────────── items (catalog chips, BOM columns) ─────────────────────────────

export interface ItemStandardsFields {
  /** document title of the primary cited standard ('' when the item cites none) */
  standard: string;
  standardVersion: string;
  /** status label of the item's weakest document status ('' when none) */
  specStatus: string;
  /** chip text of the implementation level ('' when none) */
  implementationLevel: string;
  /** weakest verification label across the item's standards entries ('' when none) */
  verification: string;
}

export const EMPTY_STANDARDS_FIELDS: ItemStandardsFields = { standard: '', standardVersion: '', specStatus: '', implementationLevel: '', verification: '' };

/** BOM / export columns of a catalog item: display text only, never internal keys. */
export function itemStandardsFields(item: CatalogItem | undefined, locale: Locale = 'en'): ItemStandardsFields {
  const entries = item?.standards ?? [];
  if (!item || !entries.length) return EMPTY_STANDARDS_FIELDS;
  const cited = entries.find((s) => findStandard(s.standardId));
  const ref = cited ? findStandard(cited.standardId) : undefined;
  const primary = cited ?? entries[0];
  const worstVer = entries.reduce<Verification>((w, s) => (VERIFICATION_RANK.indexOf(s.verification) > VERIFICATION_RANK.indexOf(w) ? s.verification : w), 'verified');
  return {
    standard: ref?.title ?? '',
    standardVersion: ref?.version ?? '',
    specStatus: item.specStatus ? stdLabel(locale, 'status', item.specStatus) : '',
    implementationLevel: stdLabel(locale, 'level', primary.level),
    verification: stdLabel(locale, 'verification', worstVer),
  };
}

export interface ItemChip {
  kind: 'level' | 'draft' | 'estimate' | 'unverified';
  text: string;
  tooltip: string;
}

/** Text-only chips of a catalog item (proposal §6.2): implementation levels, draft spec, estimate / unverified values. */
export function itemStandardsChips(item: CatalogItem, locale: Locale = 'en'): ItemChip[] {
  const chips: ItemChip[] = [];
  const seen = new Set<string>();
  for (const s of item.standards ?? []) {
    if (seen.has(s.level)) continue;
    seen.add(s.level);
    const ref = findStandard(s.standardId);
    const doc = ref ? `${ref.title} ${ref.version}` : s.classId ? findCatalogItem(s.classId)?.name ?? '' : '';
    chips.push({ kind: 'level', text: stdLabel(locale, 'level', s.level), tooltip: stdLabel(locale, 'levelTip', s.level, { doc: doc || '—', status: ref ? stdLabel(locale, 'status', ref.status) : '—' }) });
  }
  if (item.specStatus && isDraftStatus(item.specStatus)) chips.push({ kind: 'draft', text: stdLabel(locale, 'chip', 'draft'), tooltip: stdLabel(locale, 'chip', 'draftTip') });
  const vers = new Set([...(item.standards ?? []).map((s) => s.verification), ...Object.values(item.paramSources ?? {}).map((p) => p.verification)]);
  if (vers.has('estimate')) chips.push({ kind: 'estimate', text: stdLabel(locale, 'chip', 'estimate'), tooltip: stdLabel(locale, 'verification', 'estimate') });
  if (vers.has('unverified')) chips.push({ kind: 'unverified', text: stdLabel(locale, 'chip', 'unverified'), tooltip: stdLabel(locale, 'verification', 'unverified') });
  return chips;
}

// ───────────────────────────── profile ─────────────────────────────

/** Field / value rows of a profile (labels only). */
export function profileRows(p: StandardsProfile, locale: Locale = 'en'): [string, string][] {
  const F = FIELD_LABEL[locale];
  return [
    [F.preset, presetLabel(p, locale)],
    [F.rackForm, stdLabel(locale, 'rackForm', p.rackForm)],
    [F.rackPower, stdLabel(locale, 'rackPower', p.rackPower)],
    [F.shelfClass, stdLabel(locale, 'shelfClass', p.shelfClass ?? 'none')],
    [F.bbu, stdLabel(locale, 'bbu', p.bbu ?? 'none')],
    [F.connector, stdLabel(locale, 'connector', p.liquid.connector)],
    [F.rackManifold, stdLabel(locale, 'rackManifold', p.liquid.rackManifold)],
    [F.cduClass, stdLabel(locale, 'cduClass', p.liquid.cduClass)],
    [F.cduRatingBasis, stdLabel(locale, 'cduRatingBasis', p.liquid.cduRatingBasis ?? 'none')],
    [F.fluid, stdLabel(locale, 'fluid', p.liquid.fluid)],
    [F.fwsClass, stdLabel(locale, 'fwsClass', p.liquid.fwsClass ?? 'none')],
    [F.air, stdLabel(locale, 'air', p.air)],
    [F.facilityPrecheck, stdLabel(locale, 'facilityPrecheck', p.facilityPrecheck ?? 'off')],
    [F.strictness, stdLabel(locale, 'strictness', p.strictness)],
    [F.drafts, stdLabel(locale, 'drafts', p.includeDraftSpecs ? 'on' : 'off')],
  ];
}

const FIELD_LABEL: Record<Locale, Record<'preset' | 'rackForm' | 'rackPower' | 'shelfClass' | 'bbu' | 'connector' | 'rackManifold' | 'cduClass' | 'cduRatingBasis' | 'fluid' | 'fwsClass' | 'air' | 'facilityPrecheck' | 'strictness' | 'drafts', string>> = {
  en: { preset: 'Profile', rackForm: 'Rack form', rackPower: 'Rack power', shelfClass: 'Power shelf', bbu: 'Battery backup', connector: 'Liquid connector', rackManifold: 'Rack manifold', cduClass: 'CDU class', cduRatingBasis: 'CDU rating basis', fluid: 'Coolant', fwsClass: 'Facility water class', air: 'Air side', facilityPrecheck: 'Facility pre-check', strictness: 'Check strictness', drafts: 'Draft specs' },
  ko: { preset: '프로필', rackForm: '랙 폼', rackPower: '랙 전원', shelfClass: '전원 셸프', bbu: '배터리 백업', connector: '액체 커넥터', rackManifold: '랙 매니폴드', cduClass: 'CDU 등급', cduRatingBasis: 'CDU 정격 기준', fluid: '냉각수', fwsClass: '시설수 등급', air: '공기측', facilityPrecheck: '시설 사전점검', strictness: '점검 엄격도', drafts: '초안 사양' },
};

/** Registry entries pinned by a profile, in family order (unknown ids are skipped). */
export function pinnedDocuments(p: StandardsProfile | undefined): { family: StandardFamily; ref: StandardRef }[] {
  if (!p) return [];
  const out: { family: StandardFamily; ref: StandardRef }[] = [];
  const seen = new Set<string>();
  const fams = [...FAMILY_ORDER, ...(Object.keys(p.pinned ?? {}) as StandardFamily[]).filter((f) => !FAMILY_ORDER.includes(f))];
  for (const f of fams) {
    for (const id of p.pinned?.[f] ?? []) {
      const ref = findStandard(id);
      if (!ref || seen.has(id)) continue;
      seen.add(id);
      out.push({ family: f, ref });
    }
  }
  return out;
}

/**
 * One-line standards basis for drawing title blocks and legends, e.g.
 * "High-power 21-inch OU racks, liquid-cooled — per Open Rack V3 Base Specification Rev 1.1". Undefined without a profile.
 */
export function standardsBasisLine(project: Pick<Project, 'standards' | 'halls'>, hall: Hall | string | undefined, locale: Locale = 'en'): { profile: string; citation: string; inferred: boolean } | undefined {
  const p = effectiveStandardsProfile(project, hall);
  if (!p) return undefined;
  const rackDoc = p.pinned?.rack?.find((id) => findStandard(id));
  const per = locale === 'ko' ? '기준 문서' : 'per';
  const citation = rackDoc ? `${per} ${standardCitation(rackDoc)}` : stdLabel(locale, 'rackForm', p.rackForm);
  const inferredTag = p.inferred ? (locale === 'ko' ? ' (추론됨)' : ' (inferred)') : '';
  return { profile: `${presetLabel(p, locale)}${inferredTag}`, citation, inferred: !!p.inferred };
}

/** Rack-standard row of rack-elevation sheets: "Rack standard: <title version> · pitch 48 mm OU" (or 44.45 mm U for EIA). */
export function rackStandardLine(project: Pick<Project, 'standards' | 'halls'>, hall: Hall | string | undefined, locale: Locale = 'en'): string | undefined {
  const p = effectiveStandardsProfile(project, hall);
  if (!p) return undefined;
  const eia = p.rackForm === 'eia-310-19';
  const doc = p.pinned?.rack?.find((id) => findStandard(id));
  const title = doc ? standardCitation(doc) : stdLabel(locale, 'rackForm', p.rackForm);
  const pitch = eia ? '44.45 mm U' : '48 mm OU';
  return locale === 'ko' ? `랙 표준: ${title} · 단위 피치 ${pitch}` : `Rack standard: ${title} · pitch ${pitch}`;
}

// ───────────────────────────── checks ─────────────────────────────

export interface CheckFamilySummary {
  family: StandardsCheckDetail['family'];
  errors: number;
  warnings: number;
  info: number;
}

/** Findings of the standards parameter checks (issues carrying `check`) counted per family, in family order. */
export function checkFindingsByFamily(issues: readonly Issue[]): CheckFamilySummary[] {
  const map = new Map<StandardsCheckDetail['family'], CheckFamilySummary>();
  for (const i of issues) {
    if (!i.check) continue;
    const f = i.check.family;
    const row = map.get(f) ?? { family: f, errors: 0, warnings: 0, info: 0 };
    if (i.severity === 'error') row.errors++;
    else if (i.severity === 'warning') row.warnings++;
    else row.info++;
    map.set(f, row);
  }
  return CHECK_FAMILY_ORDER.filter((f) => map.has(f)).map((f) => map.get(f)!);
}

// ───────────────────────────── design document section ─────────────────────────────

const DOC = {
  en: {
    title: 'Standards basis',
    none: 'No standards profile is set for this project, so standards parameter checks do not run. Cited values of individual catalog items are listed in the equipment table above.',
    inferred: 'The profile below was inferred from the placed equipment and has not been confirmed. Standards parameter checks are reported as information only until it is confirmed.',
    advisory: 'Check strictness: advisory. Parameter checks compare design values with limits cited from the documents below and report findings as warnings at most.',
    gate: 'Check strictness: design gate. Findings against published documents keep their severity; findings based on draft or in-review documents, or on estimates, stay warnings at most.',
    profileTitle: 'Profile', field: 'Field', value: 'Value',
    hallOverride: (hall: string) => `Hall override — ${hall}`,
    pinnedTitle: 'Pinned documents', family: 'Family', document: 'Document', version: 'Version', date: 'Date', status: 'Status', licence: 'Licence', url: 'Public URL',
    noPinned: 'No documents are pinned by this profile.',
    checksTitle: 'Parameter check summary', errors: 'Errors', warnings: 'Warnings', info: 'Info',
    noFindings: 'No standards parameter check reported a finding for this design.',
    checksNote: 'Parameter checks are informational design aids. They are not assessments, compliance statements or certifications.',
    facilityTitle: (hall: string, citation: string) => `Facility pre-check — ${hall} (${citation})`,
    ref: 'Ref.', attribute: 'Attribute', design: 'Design value', level: 'Result', threshold: 'Threshold',
    estimates: 'Values tagged "estimate" or "unverified" in the catalog (for example generic node power, rack mass and row geometry) are planning assumptions; confirm them before procurement.',
  },
  ko: {
    title: '표준 기반',
    none: '이 프로젝트에는 표준 프로필이 설정되어 있지 않아 표준 파라미터 점검을 실행하지 않습니다. 개별 카탈로그 항목의 인용 값은 위 장비 표에 있습니다.',
    inferred: '아래 프로필은 배치된 장비에서 추론했고 아직 확정되지 않았습니다. 확정하기 전까지 표준 파라미터 점검 결과는 정보로만 표시합니다.',
    advisory: '점검 엄격도: 정보용. 파라미터 점검은 설계값을 아래 문서에서 인용한 한도와 비교하며, 결과는 최대 경고로 표시합니다.',
    gate: '점검 엄격도: 설계 게이트. 발행 문서 기준 결과는 원래 심각도를 유지하고, 초안·검토 중 문서나 추정값 기준 결과는 최대 경고로 표시합니다.',
    profileTitle: '프로필', field: '항목', value: '값',
    hallOverride: (hall: string) => `홀 덮어쓰기 — ${hall}`,
    pinnedTitle: '고정 문서', family: '분야', document: '문서', version: '버전', date: '날짜', status: '상태', licence: '라이선스', url: '공개 URL',
    noPinned: '이 프로필이 고정한 문서가 없습니다.',
    checksTitle: '파라미터 점검 요약', errors: '오류', warnings: '경고', info: '정보',
    noFindings: '이 설계에서 표준 파라미터 점검 결과가 없습니다.',
    checksNote: '파라미터 점검은 정보용 설계 보조 수단입니다. 평가, 준수 선언, 인증이 아닙니다.',
    facilityTitle: (hall: string, citation: string) => `시설 사전점검 — ${hall} (${citation})`,
    ref: '항목 번호', attribute: '항목', design: '설계값', level: '결과', threshold: '기준',
    estimates: '카탈로그에서 "추정" 또는 "미검증"으로 표시된 값(예: 제네릭 노드 전력, 랙 중량, 행 형상)은 계획용 가정입니다. 구매 전에 확인하십시오.',
  },
} satisfies Record<Locale, Record<string, unknown>>;

const HALL_OVERRIDE_KEYS = ['rackForm', 'rackPower', 'shelfClass', 'bbu', 'air', 'facilityPrecheck', 'strictness'] as const;

/**
 * "Standards basis" section of the design document (proposal §6.3): profile, pinned documents (title, version, date, status,
 * licence, URL), parameter-check summary, facility pre-check tables and the non-affiliation notice. Rendered for every project;
 * a project without a profile gets the short "no profile" statement and the notice.
 */
export function standardsBasisBlocks(project: Project, analysis: ProjectAnalysis, locale: Locale = 'en'): DocBlock[] {
  const S = DOC[locale];
  const B: DocBlock[] = [];
  const blank = () => B.push({ k: 'blank' });
  const p = (text: string) => B.push({ k: 'p', text });
  const h4 = (text: string) => B.push({ k: 'h', level: 4, text });
  const table = (headers: string[], rows: (string | number)[][]) => B.push({ k: 'table', headers, rows });
  const n = (v: number | string | undefined) => (v === undefined ? '-' : typeof v === 'number' ? v.toLocaleString(locale === 'ko' ? 'ko-KR' : 'en-US', { maximumFractionDigits: 2 }) : v);

  blank();
  B.push({ k: 'h', level: 3, text: S.title });
  blank();
  const profile = project.standards;
  if (!profile) {
    p(S.none);
  } else {
    p(profile.inferred ? S.inferred : profile.strictness === 'gate' ? S.gate : S.advisory);
    blank();
    h4(S.profileTitle);
    blank();
    table([S.field, S.value], profileRows(profile, locale));
    for (const hall of project.halls) {
      const o = hall.standards;
      if (!o || !Object.keys(o).length) continue;
      const eff = effectiveStandardsProfile(project, hall)!;
      const base = profileRows(profile, locale);
      const rows = profileRows(eff, locale).filter((r, i) => r[1] !== base[i][1]);
      if (!rows.length && !HALL_OVERRIDE_KEYS.some((k) => o[k] !== undefined)) continue;
      blank();
      h4(S.hallOverride(hall.name));
      blank();
      table([S.field, S.value], rows.length ? rows : [[S.field, '-']]);
    }
    blank();
    h4(S.pinnedTitle);
    blank();
    const docs = pinnedDocuments(profile);
    if (docs.length) {
      table([S.family, S.document, S.version, S.date, S.status, S.licence, S.url], docs.map(({ family, ref }) => [
        stdLabel(locale, 'family', family), ref.title, ref.version, ref.date || '-', stdLabel(locale, 'status', ref.status), stdLabel(locale, 'licence', ref.licence), ref.url,
      ]));
    } else p(S.noPinned);
    blank();
    h4(S.checksTitle);
    blank();
    const fam = checkFindingsByFamily(analysis.issues);
    if (fam.length) table([S.family, S.errors, S.warnings, S.info], fam.map((f) => [stdLabel(locale, 'family', f.family), f.errors, f.warnings, f.info]));
    else p(S.noFindings);
    blank();
    p(S.checksNote);
    // facility pre-check tables (halls whose effective profile enables a basis)
    let placed: ReturnType<typeof buildContext>['placed'] | undefined;
    for (const hall of project.halls) {
      const basisId = facilityPrecheckBasis(effectiveStandardsProfile(project, hall));
      if (!basisId) continue;
      placed ??= buildContext(project).placed;
      const rep = facilityPrecheck(project, hall, basisId, placed);
      blank();
      h4(S.facilityTitle(hall.name, rep.citation));
      blank();
      table([S.ref, S.attribute, S.design, S.level, S.threshold], rep.rows.map((r) => [
        r.ref, locale === 'ko' ? r.attributeKo : r.attributeEn, r.designValue !== undefined ? `${n(r.designValue)}${r.unit ? ` ${r.unit}` : ''}` : '-', stdLabel(locale, 'facilityLevel', r.level), r.thresholdEn ?? '-',
      ]));
      blank();
      p(locale === 'ko' ? rep.summaryKo : rep.summaryEn);
    }
    blank();
    p(S.estimates);
  }
  blank();
  p(`> ${STANDARDS_NOTICE[locale]}`);
  return B;
}
