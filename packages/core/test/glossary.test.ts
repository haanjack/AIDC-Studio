import { describe, expect, it } from 'vitest';
import { GLOSSARY, GLOSSARY_DOMAINS, findTerm, findTermByAlias, searchTerms, termLabel, termShort, termsByDomain } from '../src/index.ts';

describe('glossary integrity', () => {
  it('has ~150+ terms with unique ids', () => {
    expect(GLOSSARY.length).toBeGreaterThanOrEqual(150);
    const ids = GLOSSARY.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id, id).toMatch(/^[a-z0-9-]+$/);
  });

  it('every term has both locales for term and short (and long when present)', () => {
    for (const t of GLOSSARY) {
      expect(t.term.en, t.id).toBeTruthy();
      expect(t.term.ko, t.id).toBeTruthy();
      expect(t.short.en, t.id).toBeTruthy();
      expect(t.short.ko, t.id).toBeTruthy();
      expect(t.term.ko, `${t.id} ko term`).toMatch(/[가-힣]|[A-Za-z0-9]/);
      expect(t.short.ko, `${t.id} ko short`).toMatch(/[가-힣]/);
      if (t.long) {
        expect(t.long.en, t.id).toBeTruthy();
        expect(t.long.ko, t.id).toMatch(/[가-힣]/);
      }
      expect(GLOSSARY_DOMAINS).toContain(t.domain ?? 'general');
    }
  });

  it('related ids all resolve', () => {
    for (const t of GLOSSARY) for (const r of t.related ?? []) expect(findTerm(r), `${t.id} → ${r}`).toBeDefined();
  });

  it('covers the required NVIDIA reference / AMD / network vocabulary', () => {
    const required = ['su', 'du', 'rcu', 'hac', 'cac', 'cin', 'cub', 'tcs', 'fws', 'atd', 'rpp', 'edp', 'edpp', 'maxp', 'maxlps', 'bess', 'oversubscription', 'undersubscription',
      'rail-optimized', 'leaf', 'spine', 'core', 'tiers', 'radix', 'ecmp', 'ebgp', 'evpn', 'ddc', 'voq', 'pxn', 'dcqcn', 'pfc', 'ecn', 'cnp', 'dscp', 'busbw', 'mfu', 'goodput', 'mtbi',
      'ttft', 'tpot', 'kv-cache', 'prefill-decode', 'dac', 'acc', 'aec', 'aoc', 'sr8', 'dr8', 'lpo', 'cpo', 'mpo', 'osfp', 'mmr', 'tray', 'busway', 'ups-topology', 'rci', 'rti', 'shi',
      'pue', 'ppue', 'wue', 'cue', 'cdu', 'crah', 'fan-wall', 'rdhx', 'sidecar', 'ashrae-w', 'orv3', 'oam', 'nvlink', 'ualink', 'xgmi'];
    for (const id of required) expect(findTerm(id), id).toBeDefined();
  });

  it('oversubscription carries the 1:1 / 3:1 examples and the notation note', () => {
    const t = findTerm('oversubscription')!;
    expect(t.long?.en).toContain('32 server ports');
    expect(t.long?.en).toContain('3:1');
    expect(t.long?.en).toContain('1:3 blocking');
    expect(t.long?.en).toContain('1:1.16');
    expect(t.long?.ko).toContain('1:1.16');
  });

  it('resolves aliases, acronyms and localised names case-insensitively', () => {
    expect(findTermByAlias('SU')?.id).toBe('su');
    expect(findTermByAlias('scalable unit')?.id).toBe('su');
    expect(findTermByAlias('over-subscription')?.id).toBe('oversubscription');
    expect(findTermByAlias('NCP')?.id).toBe('ddc');
    expect(findTermByAlias('Max-Q')?.id).toBe('maxp');
    expect(findTermByAlias('핫에일 컨테인먼트')?.id).toBe('hac');
    expect(findTermByAlias('2N')?.id).toBe('ups-topology');
    expect(findTermByAlias('does-not-exist')).toBeUndefined();
  });

  it('labels, shorts, domains and search work per locale', () => {
    expect(termLabel('pue', 'ko')).toContain('PUE');
    expect(termLabel('nope')).toBe('nope');
    expect(termShort('pue', 'en')).toContain('IT energy');
    expect(termsByDomain('cooling').length).toBeGreaterThan(10);
    expect(searchTerms('rail', 'en').map((t) => t.id)).toContain('rail-optimized');
    expect(searchTerms('레일', 'ko').map((t) => t.id)).toContain('rail-optimized');
  });
});
