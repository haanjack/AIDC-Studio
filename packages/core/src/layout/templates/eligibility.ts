import { canonicalConnector, neutralRackClass, rackFormFromMeta, type NeutralRackClass } from '../../catalog/aliases.ts';
import { catalogItems, findCatalogItem } from '../../catalog/catalog.ts';
import { rackPowerOf } from '../../engines/standardsChecks.ts';
import type { CatalogItem } from '../../model/types.ts';
import { isDraftStatus, NEUTRAL_REFERENCE_BASIS, standardCitation } from '../../standards/registry.ts';
import type { HallStandardsOverride, RackPowerKey, StandardsProfile } from '../../standards/types.ts';
import { findLayoutTemplate, registeredPlatformIds, standardTemplateOf, type ComputeSlot, type CoolingClass, type LayoutTemplate, type RegistryContext } from './index.ts';

/**
 * Slot eligibility by declared standards (stream D / P4; OCP-DESIGN-PROPOSAL §4.2, P0 impacts box; DECISIONS-v2-2 §I DO-4, DO-9).
 *
 * A catalog item — generic class or vendor instance — is eligible for a compute slot when every test of the slot's `accepts`
 * rule holds; otherwise it is listed greyed with the failing reasons. Only declared data is read (`meta.rackClass` / `compute`,
 * `formFactor.rack`, `rackPower`, `powerShelf`, `cooling.liquidFraction`, `liquidInterface.connector`, `power.nameplateKW`,
 * `accelModule`, `baseboard`, `nic`); no vendor id or name is compared. Items behind the drafts toggle are hidden (not
 * ineligible) unless the profile includes draft specs; draft / review / roadmap items keep a "draft spec" chip. A declared module,
 * board or NIC power above the cited base-spec envelope adds a note and never blocks.
 */

export type EligibilityRule = 'rack-class' | 'rack-form' | 'rack-power' | 'voltage-window' | 'shelf-generation' | 'cooling' | 'connector' | 'density' | 'envelope' | 'draft-filter';

export interface EligibilityReason {
  rule: EligibilityRule;
  en: string;
  ko: string;
}

export interface SlotEligibility {
  catalogId: string;
  eligible: boolean;
  /** hidden by the drafts toggle (DO-4); a hidden item is not listed at all unless draft specs are included */
  hidden: boolean;
  /** weakest spec status is draft / review / roadmap → "draft spec" chip */
  draftChip: boolean;
  /** failing tests (empty when eligible) */
  reasons: EligibilityReason[];
  /** non-blocking notes: envelope exceedances, undeclared connector / power interface */
  notes: EligibilityReason[];
}

/** Profile fields eligibility reads. */
export type EligibilityProfile = Pick<Partial<StandardsProfile>, 'rackForm' | 'rackPower' | 'shelfClass' | 'includeDraftSpecs'> & { liquid?: Partial<StandardsProfile['liquid']> };

// ───────────────────────────── classification from declared data ─────────────────────────────

/**
 * Neutral rack class from declared data (no vendor names): explicit `meta.rackClass` (legacy values mapped), else a switched
 * liquid-cooled switched scale-up domain of ≥ 36 accelerators → rack-scale liquid; 8 OAM / SXM-class modules per node → 8-module node; PCIe / card
 * accelerators → PCIe node; wafer-scale and other opaque systems → appliance.
 */
export function rackClassOf(item: CatalogItem): NeutralRackClass | undefined {
  const explicit = typeof item.meta?.rackClass === 'string' ? neutralRackClass(item.meta.rackClass) : undefined;
  if (explicit) return explicit;
  if (item.category === 'cpu-rack') return 'cpu';
  if (item.category === 'storage-rack') return 'storage';
  const c = item.compute;
  if (item.category !== 'gpu-rack' || !c) return undefined;
  const kind = c.scaleUp?.kind;
  const domain = c.scaleUp.domainSize;
  if (domain >= 36 && kind !== undefined && kind !== 'none' && kind !== 'pcie' && (item.cooling?.liquidFraction ?? 0) >= 0.7) return 'rack-scale-liquid';
  const ff = c.accelerator?.formFactor;
  if ((ff === 'oam' || ff === 'sxm') && (c.gpusPerNode ?? 0) === 8) return 'accel-node-8x';
  if (ff === 'pcie' || ff === 'card') return 'accel-node-pcie';
  return 'accelerator-appliance';
}

/** Cooling class from the declared liquid fraction: < 5 % air, ≥ 70 % DLC, else hybrid. */
export function coolingClassOf(item: CatalogItem): CoolingClass {
  const lf = item.cooling?.liquidFraction ?? 0;
  if (lf < 0.05) return 'air';
  return lf >= 0.7 ? 'dlc' : 'hybrid';
}

/** Draft visibility of any catalog item (DO-4): hidden behind the toggle (HPR V2 72 kW shelf, ±400 VDC sidecar blocks) unless drafts are included; chip for draft-status documents. */
export function draftSpecVisibility(item: CatalogItem, profile?: Pick<Partial<StandardsProfile>, 'includeDraftSpecs'>): { hidden: boolean; draftChip: boolean } {
  const toggled = item.meta?.behindDraftsToggle === true || (item.standards ?? []).some((s) => (NEUTRAL_REFERENCE_BASIS.behindDraftsToggle as readonly string[]).includes(s.standardId));
  return { hidden: toggled && profile?.includeDraftSpecs !== true, draftChip: !!item.specStatus && isDraftStatus(item.specStatus) };
}

/** HPR v1 three-set limits (draft shelf document): 27.5 kW per shelf at N+1, 93.5 kW stated total for three sets. */
const HPR_V1_N1_KW = 27.5;
const HPR_V1_TOTAL_KW = 93.5;

/** Density limit a profile implies for a busbar rack (undefined = no profile-derived limit). */
export function profileMaxRackKW(profile: EligibilityProfile | undefined, shelves = 3): number | undefined {
  if (!profile || profile.rackPower !== 'dc-busbar-50v-hpr') return undefined;
  if (profile.shelfClass && profile.shelfClass !== 'hpr-33kw') return undefined;
  return Math.min(shelves * HPR_V1_N1_KW, HPR_V1_TOTAL_KW);
}

const POWER_LABEL: Record<RackPowerKey, { en: string; ko: string }> = {
  'ac-pdu': { en: 'AC rack PDU', ko: 'AC 랙 PDU' },
  'dc-busbar-48-54v': { en: '48–54 V busbar', ko: '48–54 V 버스바' },
  'dc-busbar-50v-hpr': { en: '50 V high-power busbar', ko: '50 V 고전력 버스바' },
  'hvdc-pm400-sidecar': { en: '±400 VDC sidecar', ko: '±400 VDC 사이드카' },
  'vendor-busbar': { en: 'vendor busbar', ko: '벤더 버스바' },
};
const FORM_LABEL: Record<string, { en: string; ko: string }> = {
  'eia-310-19': { en: '19-inch EIA rack', ko: '19인치 EIA 랙' },
  orv3: { en: '21-inch OU rack', ko: '21인치 OU 랙' },
  'orv3-hpr': { en: 'high-power 21-inch OU rack', ko: '고전력 21인치 OU 랙' },
  'orv3-mgx': { en: '21-inch-wide vendor rack-scale frame', ko: '21인치 폭 벤더 랙 스케일 프레임' },
  orw: { en: 'wide OU rack', ko: '와이드 OU 랙' },
  mixed: { en: 'mixed racks', ko: '혼합 랙' },
};
const CLASS_LABEL: Record<NeutralRackClass, { en: string; ko: string }> = {
  'rack-scale-liquid': { en: 'rack-scale liquid domain', ko: '랙 스케일 액체냉각 도메인' },
  'accel-node-8x': { en: '8-module accelerator node rack', ko: '8모듈 가속기 노드 랙' },
  'accel-node-pcie': { en: 'PCIe accelerator node rack', ko: 'PCIe 가속기 노드 랙' },
  'accelerator-appliance': { en: 'accelerator appliance', ko: '가속기 어플라이언스' },
  cpu: { en: 'CPU rack', ko: 'CPU 랙' },
  storage: { en: 'storage rack', ko: '스토리지 랙' },
};
const COOLING_LABEL: Record<CoolingClass, { en: string; ko: string }> = { air: { en: 'air', ko: '공랭' }, hybrid: { en: 'hybrid', ko: '하이브리드' }, dlc: { en: 'direct liquid', ko: '직접 액체냉각' } };
const lbl = <T extends string>(m: Record<T, { en: string; ko: string }>, keys: readonly T[], lang: 'en' | 'ko') => keys.map((k) => m[k]?.[lang] ?? k).join(lang === 'en' ? ' / ' : ' / ');

/** OAM r2.0 module envelope, UBB r2.0 board envelope, air recommendation, NIC 3.0 slot envelopes (registry-cited values). */
const OAM_MODULE_W = 1000;
const OAM_AIR_W = 600;
const UBB_BOARD_W = 12_000;
const UBB_EXP_W = 3200;
const NIC_SLOT_W: Record<string, number> = { 'nic3-sff': 80, 'nic3-tsff': 80, 'nic3-dsff': 160, 'nic3-tdsff': 160, 'nic3-lff': 150 };

/** Envelope notes (never block): module / board / NIC power above the cited base-spec envelope; air module above the recommendation. */
export function envelopeNotes(item: CatalogItem, cooling: CoolingClass = coolingClassOf(item)): EligibilityReason[] {
  const out: EligibilityReason[] = [];
  const moduleW = item.accelModule?.tdpW;
  const oam = item.accelModule?.standard === 'oam-2.0' || item.accelModule?.standard === 'oam-1.x' || (!item.accelModule && item.compute?.accelerator?.formFactor === 'oam');
  if (oam && moduleW !== undefined && moduleW > OAM_MODULE_W)
    out.push({ rule: 'envelope', en: `Module ${moduleW} W exceeds the ${OAM_MODULE_W} W module power envelope (${standardCitation('oam-base@2.0-1.0')}); allowed, flagged.`, ko: `모듈 ${moduleW} W가 모듈 전력 범위 ${OAM_MODULE_W} W(${standardCitation('oam-base@2.0-1.0')})를 넘습니다. 허용하되 표시합니다.` });
  if (oam && moduleW !== undefined && cooling === 'air' && moduleW > OAM_AIR_W)
    out.push({ rule: 'envelope', en: `Air-cooled module ${moduleW} W is above the ${OAM_AIR_W} W air recommendation (CL-15, info).`, ko: `공랭 모듈 ${moduleW} W가 공랭 권장 ${OAM_AIR_W} W를 넘습니다(CL-15, 정보).` });
  const bb = item.baseboard;
  if (bb?.standard === 'ubb-2.0' && moduleW !== undefined) {
    const boardW = bb.modules * (moduleW + (bb.opt12VPerModuleW ?? 0)) + UBB_EXP_W;
    const cap = bb.maxBoardW ?? UBB_BOARD_W;
    if (boardW > cap) out.push({ rule: 'envelope', en: `Baseboard ${boardW} W (${bb.modules} × ${moduleW} W + 12 V + ${UBB_EXP_W} W) exceeds the ${cap} W board envelope (CL-16).`, ko: `베이스보드 ${boardW} W(${bb.modules} × ${moduleW} W + 12 V + ${UBB_EXP_W} W)가 보드 범위 ${cap} W를 넘습니다(CL-16).` });
  }
  const nicFF = item.nic?.formFactor;
  const nicW = item.nic?.wattsMax;
  if (nicFF && nicW !== undefined && NIC_SLOT_W[nicFF] !== undefined && nicW > NIC_SLOT_W[nicFF])
    out.push({ rule: 'envelope', en: `NIC ${nicW} W exceeds the ${NIC_SLOT_W[nicFF]} W slot envelope of its form factor (${standardCitation('nic3@1.6.0')}).`, ko: `NIC ${nicW} W가 폼팩터 슬롯 범위 ${NIC_SLOT_W[nicFF]} W(${standardCitation('nic3@1.6.0')})를 넘습니다.` });
  return out;
}

// ───────────────────────────── slot eligibility ─────────────────────────────

/**
 * Eligibility of one catalog item for a slot. `profile` supplies the shelf class / rack power for `maxRackKW: 'profile'` and the
 * drafts toggle; a slot without `accepts` only tests the drafts toggle (registration lists stay the rule there).
 */
export function slotEligibility(slot: ComputeSlot, item: CatalogItem, profile?: EligibilityProfile): SlotEligibility {
  const reasons: EligibilityReason[] = [];
  const notes: EligibilityReason[] = [];
  const a = slot.accepts;
  const vis = draftSpecVisibility(item, profile);
  const cooling = coolingClassOf(item);
  if (a) {
    // rack class
    const cls = rackClassOf(item);
    if (!cls || !a.rackClasses.includes(cls))
      reasons.push({ rule: 'rack-class', en: `Rack class ${cls ? CLASS_LABEL[cls].en : 'not declared'}; the slot takes ${lbl(CLASS_LABEL, a.rackClasses, 'en')}.`, ko: `랙 클래스가 ${cls ? CLASS_LABEL[cls].ko : '선언되지 않음'}입니다. 이 슬롯은 ${lbl(CLASS_LABEL, a.rackClasses, 'ko')}을(를) 받습니다.` });
    // rack form
    const form = item.formFactor?.rack ?? rackFormFromMeta(item.meta?.rackForm);
    if (a.rackForms && (!form || !a.rackForms.includes(form)))
      reasons.push({ rule: 'rack-form', en: `Rack form ${form ? FORM_LABEL[form]?.en ?? form : 'not declared'}; the slot takes ${a.rackForms.map((f) => FORM_LABEL[f]?.en ?? f).join(' / ')}.`, ko: `랙 폼팩터가 ${form ? FORM_LABEL[form]?.ko ?? form : '선언되지 않음'}입니다. 이 슬롯은 ${a.rackForms.map((f) => FORM_LABEL[f]?.ko ?? f).join(' / ')}을(를) 받습니다.` });
    // rack power interface (declared or implied by the declared form)
    const power = rackPowerOf(item);
    if (a.rackPower) {
      if (!power) notes.push({ rule: 'rack-power', en: 'Rack power interface not declared; check it against the slot.', ko: '랙 전원 인터페이스가 선언되지 않았습니다. 슬롯과 맞는지 확인하세요.' });
      else if (!a.rackPower.includes(power))
        reasons.push({ rule: 'rack-power', en: `Rack power ${POWER_LABEL[power].en}; the slot takes ${lbl(POWER_LABEL, a.rackPower, 'en')}.`, ko: `랙 전원이 ${POWER_LABEL[power].ko}입니다. 이 슬롯은 ${lbl(POWER_LABEL, a.rackPower, 'ko')}을(를) 받습니다.` });
    }
    // IT input window vs declared shelf output
    const range = item.rackPower?.rangeV;
    const out = item.powerShelf?.outputV;
    if (range && out) {
      const lo = Math.min(...out);
      const hi = Math.max(...out);
      if (lo < range[0] || hi > range[1])
        reasons.push({ rule: 'voltage-window', en: `Shelf output ${lo}–${hi} V is outside the IT input window ${range[0]}–${range[1]} V.`, ko: `셸프 출력 ${lo}–${hi} V가 IT 입력 범위 ${range[0]}–${range[1]} V를 벗어납니다.` });
    }
    // cooling class
    if (a.cooling && !a.cooling.includes(cooling))
      reasons.push({ rule: 'cooling', en: `Cooling ${COOLING_LABEL[cooling].en}; the slot takes ${lbl(COOLING_LABEL, a.cooling, 'en')}.`, ko: `냉각 방식이 ${COOLING_LABEL[cooling].ko}입니다. 이 슬롯은 ${lbl(COOLING_LABEL, a.cooling, 'ko')}을(를) 받습니다.` });
    // liquid connector ↔ rack manifold
    if (a.connectors && cooling !== 'air') {
      const conn = item.liquidInterface?.connector ? canonicalConnector(item.liquidInterface.connector) : undefined;
      if (!conn || conn === 'vendor' || conn === 'none')
        notes.push({ rule: 'connector', en: 'Liquid connector not declared (vendor interface); check the rack manifold fit.', ko: '액체 커넥터가 선언되지 않았습니다(벤더 인터페이스). 랙 매니폴드와 맞는지 확인하세요.' });
      else if (conn === 'pbmc' && a.connectors.includes('bmqc'))
        reasons.push({ rule: 'connector', en: `Pivoting blind-mate coupling: fit with the 21-inch blind-mate rack manifold is not established (${standardCitation('pbmc@1.0')}), so it is not auto-eligible.`, ko: `피벗 블라인드메이트 커플링은 21인치 블라인드메이트 랙 매니폴드와의 결합이 확인되지 않아(${standardCitation('pbmc@1.0')}) 자동으로 적격이 되지 않습니다.` });
      else if (!a.connectors.includes(conn as never))
        reasons.push({ rule: 'connector', en: `Liquid connector ${conn} does not mate with the slot manifold (${a.connectors.join(' / ')}).`, ko: `액체 커넥터 ${conn}가 슬롯 매니폴드(${a.connectors.join(' / ')})와 맞지 않습니다.` });
    }
    // density
    const limit = a.maxRackKW === 'profile' ? profileMaxRackKW(profile ?? {}) : a.maxRackKW;
    const kw = item.power?.nameplateKW;
    if (limit !== undefined && kw !== undefined && power !== 'vendor-busbar' && kw > limit + 1e-9)
      reasons.push({ rule: 'density', en: `Rack ${kw} kW exceeds the slot limit ${limit} kW.`, ko: `랙 ${kw} kW가 슬롯 한도 ${limit} kW를 넘습니다.` });
  }
  // shelf generation (any item that declares a shelf): 72 kW shelves bolt to a power-rack busbar, not the v1 IT-rack busbar
  if (item.powerShelf?.busbarInterface === 'hprv3-power-rack-bolted' && profile?.shelfClass !== 'hpr-v2-72kw' && (profile?.rackPower === 'dc-busbar-50v-hpr' || a?.rackPower?.includes('dc-busbar-50v-hpr')))
    reasons.push({ rule: 'shelf-generation', en: 'This shelf bolts to a power-rack vertical busbar; it does not fit the 700 A clip busbar of a high-power IT rack.', ko: '이 셸프는 파워랙 수직 버스바에 볼트로 체결합니다. 고전력 IT 랙의 700 A 클립 버스바에는 맞지 않습니다.' });
  notes.push(...envelopeNotes(item, cooling));
  return { catalogId: item.id, eligible: reasons.length === 0, hidden: vis.hidden, draftChip: vis.draftChip, reasons, notes };
}

/** Eligibility profile of a template: the standard base's profile, with the caller's drafts toggle / overrides on top. */
export function templateEligibilityProfile(t: LayoutTemplate, override?: EligibilityProfile | HallStandardsOverride): EligibilityProfile {
  const base = standardTemplateOf(t)?.profile ?? t.profile ?? {};
  return { rackForm: base.rackForm, rackPower: base.rackPower, shelfClass: base.shelfClass, liquid: base.liquid, includeDraftSpecs: override?.includeDraftSpecs ?? false, ...(override?.shelfClass ? { shelfClass: override.shelfClass } : {}) };
}

export interface SlotCandidate extends SlotEligibility {
  name: string;
  registered: boolean;
}

/**
 * Every placeable compute rack of the active catalog for a slot: registered + eligible first, then eligible, then ineligible
 * (with reasons); items hidden by the drafts toggle are dropped unless `includeHidden`. `profile` carries the project's drafts toggle.
 */
export function slotCandidates(templateId: string, slotId: string, ctx: RegistryContext & { profile?: EligibilityProfile; includeHidden?: boolean } = {}): SlotCandidate[] {
  const t = findLayoutTemplate(templateId);
  const slot = t?.computeSlots.find((s) => s.id === slotId);
  if (!t || !slot) return [];
  const profile = templateEligibilityProfile(t, ctx.profile);
  const reg = new Set(registeredPlatformIds(templateId, slotId, ctx));
  const out: SlotCandidate[] = [];
  for (const item of catalogItems()) {
    if (item.category !== 'gpu-rack' || item.meta?.placeable === false) continue;
    const e = slotEligibility(slot, item, profile);
    if (e.hidden && !ctx.includeHidden) continue;
    out.push({ ...e, name: item.name, registered: reg.has(item.id) });
  }
  const rank = (c: SlotCandidate) => (c.eligible ? (c.registered ? 0 : 1) : 2);
  return out.sort((x, y) => rank(x) - rank(y) || x.name.localeCompare(y.name));
}

/** Eligibility of one catalog id for a template slot (undefined when the template, slot or item is unknown). */
export function platformEligibility(templateId: string, slotId: string, catalogId: string, profile?: EligibilityProfile): SlotEligibility | undefined {
  const t = findLayoutTemplate(templateId);
  const slot = t?.computeSlots.find((s) => s.id === slotId);
  const item = findCatalogItem(catalogId);
  if (!t || !slot || !item) return undefined;
  return slotEligibility(slot, item, templateEligibilityProfile(t, profile));
}

// ───────────────────────────── ±400 VDC sidecar sizing (DO-9) ─────────────────────────────

export interface SidecarPlan {
  inputV: 480 | 415 | 400;
  /** rating per power rack at the input voltage, kW (minimum capability) */
  ratingKW: number;
  itKW: number;
  powerRacks: number;
  /** DC links per IT rack at `linkKW` per link */
  linksPerRack: number[];
  totalLinks: number;
  linkKW: 50 | 100;
  /** facility AC input cords at most (power racks × 12 × 200 A) */
  maxAcCords: number;
  standardId: string;
  /** pre-1.0 draft: checks stay warnings, hidden unless draft specs are included */
  draft: true;
}

/** Power-rack ratings by input voltage (minimum capability of the cited pre-1.0 draft; same values as the seeded block). */
export const SIDECAR_RATING_BY_INPUT_V: Readonly<Record<480 | 415 | 400, number>> = { 480: 1100, 415: 1100, 400: 718 };

/**
 * Power racks for a row of sidecar-fed IT racks: ⌈Σ IT kW ÷ rating at the input voltage⌉ (one spare is the caller's choice),
 * links per rack ⌈rack kW ÷ link kW⌉. Reads the seeded power-rack block when present, else the cited ratings.
 */
export function sidecarPlan(rackKW: readonly number[], inputV: 480 | 415 | 400 = 415, opts: { linkKW?: 50 | 100; powerRackCatalogId?: string } = {}): SidecarPlan {
  const block = findCatalogItem(opts.powerRackCatalogId ?? 'power-rack-pm400');
  const ratingKW = block?.powerRack?.ratingKWByInputV?.[inputV] ?? SIDECAR_RATING_BY_INPUT_V[inputV];
  const linkKW = opts.linkKW ?? ((block?.powerRack?.linkKW as 50 | 100 | undefined) ?? 100);
  const itKW = rackKW.reduce((s, k) => s + Math.max(0, k), 0);
  const powerRacks = itKW > 0 ? Math.ceil(itKW / ratingKW - 1e-9) : 0;
  const linksPerRack = rackKW.map((k) => (k > 0 ? Math.ceil(k / linkKW - 1e-9) : 0));
  const cords = block?.powerRack?.inputs?.count ?? 12;
  return { inputV, ratingKW, itKW: Math.round(itKW * 1000) / 1000, powerRacks, linksPerRack, totalLinks: linksPerRack.reduce((s, n) => s + n, 0), linkKW, maxAcCords: powerRacks * cords, standardId: 'diablo400@0.7.0', draft: true };
}
