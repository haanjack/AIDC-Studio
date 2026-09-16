// Stream C (P3) — shared basis of the standards parameter checks (OCP-DESIGN-PROPOSAL §5).
//
// One result shape for every rule family (RK / PW in standardsChecks.ts, CL in cooling.ts, NW in standardsChecks.ts, FC in
// facilityPrecheck.ts). Findings become `Issue`s with a `check` detail; passes and not-modelled rows stay in the report.
//
// Severity (DO-3, proposal §2.5 / §5):
//   natural severity = what the rule means for a confirmed design ('error' = beyond a published rating, 'warning' = recommendation / margin)
//   no profile or inferred profile            → info (legacy projects stay advisory until the user confirms the profile)
//   strictness 'advisory' (default)           → at most warning
//   strictness 'gate'                         → natural severity, but at most warning when the basis document is draft / review /
//                                               roadmap or the value is an estimate / unverified
// Wording (P5): "Parameter check (per <title> <version>): <value> vs <limit>." — never "compliant", "passes", "certified".
// Registry ids are internal keys; messages print the document title and version from standards/registry.ts.
import type { Hall, Issue, Project, Severity, StandardsCheckDetail } from '../model/types.ts';
import { effectiveStandardsProfile } from '../standards/profile.ts';
import { findStandard, isDraftStatus, standardCitation } from '../standards/registry.ts';
import type { StandardsProfile, Verification } from '../standards/types.ts';

export type CheckStatus = 'finding' | 'pass' | 'not-modelled';
export type CheckBasis = StandardsCheckDetail['basis'];

export interface StandardsCheckResult {
  /** issue id when the result is a finding (stable: rule + subject) */
  id: string;
  ruleId: string;
  family: StandardsCheckDetail['family'];
  status: CheckStatus;
  /** severity before the DO-3 cap */
  naturalSeverity: Severity;
  /** severity after the cap (what the issue list shows) */
  severity: Severity;
  domain: Issue['domain'];
  hallId?: string;
  refs?: string[];
  designValue?: number;
  limit?: number;
  unit?: string;
  basis: CheckBasis;
  standardId?: string;
  clause?: string;
  verification: Verification;
  /** Korean UI message (engines emit Korean strings; `messageEn` for the EN deliverables) */
  message: string;
  messageEn: string;
  suggestion?: string;
  suggestionEn?: string;
}

const RANK: Record<Severity, number> = { info: 0, warning: 1, error: 2 };
const minSeverity = (a: Severity, b: Severity): Severity => (RANK[a] <= RANK[b] ? a : b);

/** True when the basis document is draft / review / roadmap (unknown ids count as roadmap, like `weakestStatus`). */
export function isDraftBasis(standardId: string | undefined): boolean {
  if (!standardId) return false;
  const s = findStandard(standardId);
  return s ? isDraftStatus(s.status) : true;
}

/** DO-3 severity cap (see the file header). */
export function capSeverity(natural: Severity, profile: StandardsProfile | undefined, b: { basis: CheckBasis; standardId?: string; verification: Verification }): Severity {
  if (!profile || profile.inferred === true) return 'info';
  const weak = b.basis === 'estimate' || b.verification === 'estimate' || b.verification === 'unverified' || isDraftBasis(b.standardId);
  if (profile.strictness !== 'gate' || weak) return minSeverity(natural, 'warning');
  return natural;
}

/** Citation used in wording: "<title> <version>" from the registry, or the planner-estimate label. */
export function citeKo(standardId: string | undefined, basis: CheckBasis): string {
  if (standardId) return `${standardCitation(standardId)} 기준`;
  return basis === 'user' ? '사용자 입력 기준' : '계획 추정';
}
export function citeEn(standardId: string | undefined, basis: CheckBasis): string {
  if (standardId) return `per ${standardCitation(standardId)}`;
  return basis === 'user' ? 'per user input' : 'planner estimate';
}

/** Format a number for messages (en-US grouping, up to `digits` decimals, trailing zeros removed). */
export function fmt(v: number | undefined, digits = 1): string {
  if (v === undefined || !Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { maximumFractionDigits: digits });
}

export interface ResultInput {
  id: string;
  ruleId: string;
  family: StandardsCheckDetail['family'];
  status: CheckStatus;
  naturalSeverity: Severity;
  domain: Issue['domain'];
  hallId?: string;
  refs?: string[];
  designValue?: number;
  limit?: number;
  unit?: string;
  basis: CheckBasis;
  standardId?: string;
  clause?: string;
  verification: Verification;
  /** subject + finding text after the "Parameter check (…)" prefix */
  ko: string;
  en: string;
  suggestion?: string;
  suggestionEn?: string;
}

/** Build a result with the standard wording prefix and the capped severity. */
export function makeResult(profile: StandardsProfile | undefined, r: ResultInput): StandardsCheckResult {
  const severity = r.status === 'finding' ? capSeverity(r.naturalSeverity, profile, r) : 'info';
  const { ko, en, ...rest } = r;
  return {
    ...rest,
    severity,
    message: `파라미터 점검 (${citeKo(r.standardId, r.basis)}, ${r.ruleId}): ${ko}`,
    messageEn: `Parameter check (${citeEn(r.standardId, r.basis)}, ${r.ruleId}): ${en}`,
  };
}

/** Findings → issues (with the `check` detail); passes and not-modelled rows are dropped. */
export function resultsToIssues(results: readonly StandardsCheckResult[]): Issue[] {
  const out: Issue[] = [];
  for (const r of results) {
    if (r.status !== 'finding') continue;
    const std = r.standardId ? findStandard(r.standardId) : undefined;
    out.push({
      id: r.id,
      severity: r.severity,
      domain: r.domain,
      message: r.message,
      messageEn: r.messageEn,
      ...(r.refs?.length ? { refs: r.refs } : {}),
      ...(r.suggestion ? { suggestion: r.suggestion } : {}),
      ...(r.suggestionEn ? { suggestionEn: r.suggestionEn } : {}),
      check: {
        ruleId: r.ruleId,
        family: r.family,
        ...(r.designValue !== undefined ? { designValue: r.designValue } : {}),
        ...(r.limit !== undefined ? { limit: r.limit } : {}),
        ...(r.unit ? { unit: r.unit } : {}),
        basis: r.basis,
        ...(r.standardId ? { standardId: r.standardId } : {}),
        ...(r.clause ? { clause: r.clause } : {}),
        ...(std ? { specStatus: std.status } : {}),
        verification: r.verification,
        naturalSeverity: r.naturalSeverity,
      },
    });
  }
  return out;
}

/** Effective profile per hall (undefined = no project profile → no standards checks). */
export function hallProfile(project: Project, hall: Hall): StandardsProfile | undefined {
  return effectiveStandardsProfile(project, hall);
}

export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Phase (line-to-neutral) voltage of the distribution voltage (V). */
export function phaseVoltage(distributionV: number): number {
  switch (distributionV) {
    case 480:
      return 277;
    case 415:
      return 240;
    case 400:
      return 230;
    case 380:
      return 220;
    default:
      return Math.round(distributionV / Math.sqrt(3));
  }
}

/** Continuous-load convention of the power plane: NEC (80 % derated breakers) when the derating factor is ≤ 0.8, else IEC (100 %). */
export const isNecConvention = (deratingFactor: number): boolean => deratingFactor <= 0.8 + 1e-9;
