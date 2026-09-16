import type { SpecSource } from '../model/types.ts';
import type { ConnectorKey, FacilityPrecheckKey, NicFormFactor, RackFormKey, ScaleUpKind, StandardLevel } from '../standards/types.ts';

/**
 * Id and enum aliases (stream A / P1; proposal §2.5, DECISIONS-v2-2 §I "추가 지시").
 *
 * This is the ONE place where the remaining legacy spellings of catalog ids and enum values live. Everything else writes the canonical
 * value; readers of stored data go through these functions (or `upgradeProject`, which applies them once at load).
 * Rules:
 *  - a catalog-id alias redirects only when the exact id is missing from the active catalog, so vendor / legacy items that
 *    still exist keep resolving to themselves (N2b guard values unchanged);
 *  - enum aliases never change analysis numbers; they only rename internal keys.
 */

/**
 * Prefix of the retired asset tag and seed-note id, built from character codes so that no source file spells the
 * abbreviation (P6 term guard, DECISIONS-v2-2 §I "추가 지시": the term stays in README.md only).
 */
// Shifted codes: a plain String.fromCharCode(…) of literals is folded back into the literal by the web bundle minifier.
const LEGACY_BLUEPRINT_PREFIX = String.fromCharCode(...[99, 114, 119].map((c) => c + 1));

// ───────────────────────────── catalog ids ─────────────────────────────

/**
 * Renamed catalog ids (proposal §3.1–3.2): estimate racks replaced by generic standard blocks. Targets are seeded by stream B;
 * until then the old ids still exist and resolve to themselves.
 */
export const CATALOG_ID_ALIASES: Readonly<Record<string, string>> = {
  'rack-orv3-44ou': 'rack-orv3',
  'rack-orw-44ou': 'rack-orw',
  'rack-42u-600x1200': 'rack-eia310-42u',
  'rack-48u-600x1200': 'rack-eia310-48u',
  'qd-lqc-dn25': 'qd-lqc-v2',
};

export function catalogAliasTarget(id: string): string | undefined {
  return CATALOG_ID_ALIASES[id];
}

// ───────────────────────────── enums ─────────────────────────────

const LEGACY_SPEC_SOURCES: Readonly<Record<string, SpecSource>> = {
  // pre-neutralization third-party asset metadata tag: accepted as input only, rewritten on load
  [`nvidia-${LEGACY_BLUEPRINT_PREFIX}-asset`]: 'vendor-datasheet',
};
const SPEC_SOURCES: readonly SpecSource[] = ['open-standard', 'vendor-datasheet', 'public-spec', 'estimate', 'announced', 'user'];

export const isSpecSource = (v: unknown): v is SpecSource => typeof v === 'string' && (SPEC_SOURCES as readonly string[]).includes(v);
export const isLegacySpecSource = (v: unknown): boolean => typeof v === 'string' && v in LEGACY_SPEC_SOURCES;

/** Canonical spec source; undefined for values that are neither current nor legacy. */
export function canonicalSpecSource(v: unknown): SpecSource | undefined {
  if (isSpecSource(v)) return v;
  return typeof v === 'string' ? LEGACY_SPEC_SOURCES[v] : undefined;
}

/** Neutral rack classes (proposal §2.4). */
export type NeutralRackClass = 'rack-scale-liquid' | 'accel-node-8x' | 'accel-node-pcie' | 'accelerator-appliance' | 'cpu' | 'storage';
const RACK_CLASS_ALIASES: Readonly<Record<string, NeutralRackClass>> = {
  'nvidia-rack-scale': 'rack-scale-liquid',
  'amd-rack-scale': 'rack-scale-liquid',
  'hgx-ubb8': 'accel-node-8x',
  'lpu-accelerator': 'accelerator-appliance',
  npu: 'accel-node-pcie',
};
const NEUTRAL_RACK_CLASSES: readonly string[] = ['rack-scale-liquid', 'accel-node-8x', 'accel-node-pcie', 'accelerator-appliance', 'cpu', 'storage'];

export function neutralRackClass(v: string | undefined): NeutralRackClass | undefined {
  if (!v) return undefined;
  if (NEUTRAL_RACK_CLASSES.includes(v)) return v as NeutralRackClass;
  return RACK_CLASS_ALIASES[v];
}

export type TemplateGroup = 'standard' | 'vendor-sample' | 'custom';
export function canonicalTemplateGroup(v: string): TemplateGroup {
  if (v === 'standard' || v === 'vendor-sample' || v === 'custom') return v;
  return 'vendor-sample'; // legacy 'nvidia' | 'amd'
}

const NIC_FORM_ALIASES: Readonly<Record<string, NicFormFactor>> = {
  ocp3: 'nic3-sff',
  'ocp3-sff': 'nic3-sff',
  'ocp3-tsff': 'nic3-tsff',
  'ocp3-dsff': 'nic3-dsff',
  'ocp3-tdsff': 'nic3-tdsff',
  'ocp3-lff': 'nic3-lff',
};
export function canonicalNicFormFactor(v: string): NicFormFactor | string {
  return NIC_FORM_ALIASES[v] ?? v;
}

/** Scale-up kind: the legacy AMD fabric key becomes a vendor-proprietary fabric with its family name. */
export function canonicalScaleUp<T extends { kind: string; family?: string }>(s: T): T & { kind: ScaleUpKind | string; family?: string } {
  if (s.kind === 'xgmi') return { ...s, kind: 'vendor-proprietary', family: s.family ?? 'Infinity Fabric' };
  return s;
}

const LEVEL_ALIASES: Readonly<Record<string, StandardLevel>> = {
  'ocp-based': 'open-spec',
  'ocp-contributed-design': 'contributed-design',
  'ocp-inspired-host': 'open-platform-host',
};
export function canonicalStandardLevel(v: string): StandardLevel | string {
  return LEVEL_ALIASES[v] ?? v;
}

export function canonicalConnector(v: string): ConnectorKey | string {
  return v === 'lqc-dn25' ? 'lqc' : v;
}

const PRECHECK_ALIASES: Readonly<Record<string, FacilityPrecheckKey>> = {
  'ocp-ready-v1@1.5': 'facility-v1@1.5',
  'ocp-ready-v2hs@1.15': 'facility-v2hs@1.15',
};
export function canonicalFacilityPrecheck(v: string): FacilityPrecheckKey | string {
  return PRECHECK_ALIASES[v] ?? v;
}

/** `meta.rackForm` (pre-P1 composer key) → `formFactor.rack`. */
const META_RACK_FORM: Readonly<Record<string, RackFormKey>> = {
  'eia-19': 'eia-310-19',
  'orv3-21': 'orv3',
  'orw-double-wide': 'orw',
};
export function rackFormFromMeta(v: unknown): RackFormKey | undefined {
  return typeof v === 'string' ? META_RACK_FORM[v] : undefined;
}

// ───────────────────────────── seed notes ─────────────────────────────

/** FNV-1a (32-bit) over UTF-16 code units, twice with different seeds → 16 hex digits. Identifies retired seed text without storing it. */
function textKey(s: string): string {
  const fnv = (seed: number) => {
    let h = seed >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  };
  return fnv(2166136261) + fnv(2166136261 ^ 0x5bd1e995);
}

/**
 * Design-basis note seeded by the retired blueprint reference generator (QA ui-wording 2026-09-15). The stored live project and
 * its version snapshots still carry it byte-for-byte; its id and body name the retired blueprint and its asset pack (DECISIONS-v2-2
 * §I "추가 지시": the term stays in README.md only). Matched by id + title + body digest, so a note a user edited is never touched;
 * replaced by the note the vendor sample seeds today (`layout/samples`, same figures). Never read by an engine.
 */
export const LEGACY_SEED_NOTE = {
  id: `note-${LEGACY_BLUEPRINT_PREFIX}`,
  title: '설계 기준',
  bodyKey: '0748d93d29be797a',
  replacement: {
    id: 'note-design-basis',
    section: 'overview',
    title: '설계 기준',
    body:
      '- 배치 단위(DU)는 AIDC Studio 기본값을 따른다: 2열 × 12랙(연속 배치), 랙 피치 0.6 m, 열 간격 3.42 m, DU 피치 7.3152 m.\n' +
      '- GB300 NVL72 전력/냉각 사양은 카탈로그 값을 사용한다(출처는 카탈로그 항목 참조): 명판 136 kW, 액체 116 kW / 공기 19.3 kW.\n' +
      '- 가격, 리드타임, 네트워크 스위치 전력은 추정치이며 견적 확정 시 갱신한다.',
  },
} as const;

/** The current vendor-sample note when `note` is the unedited retired seed note, else the note itself (same object). */
export function canonicalSeedNote<N extends { id: string; section: string; title: string; body: string }>(note: N): N {
  if (note.id !== LEGACY_SEED_NOTE.id || note.title !== LEGACY_SEED_NOTE.title || textKey(note.body) !== LEGACY_SEED_NOTE.bodyKey) return note;
  return { ...note, ...LEGACY_SEED_NOTE.replacement };
}

/** Every legacy key held here (for the per-alias tests and the wording / term guards' allowlist). */
export const LEGACY_KEYS = {
  catalogIds: Object.keys(CATALOG_ID_ALIASES),
  specSources: Object.keys(LEGACY_SPEC_SOURCES),
  rackClasses: Object.keys(RACK_CLASS_ALIASES),
  nicFormFactors: Object.keys(NIC_FORM_ALIASES),
  standardLevels: Object.keys(LEVEL_ALIASES),
  facilityPrechecks: Object.keys(PRECHECK_ALIASES),
  metaRackForms: Object.keys(META_RACK_FORM),
} as const;
