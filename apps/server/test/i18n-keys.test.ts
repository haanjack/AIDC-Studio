// UI i18n guard (stream T8): every namespace under apps/web/src/i18n/locales has the same key set in ko and en,
// keys are prefixed with the namespace, no value is empty, and `{param}` placeholders match between languages.
import { readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../web/src/i18n/locales');
const list = (locale: string) => (existsSync(join(ROOT, locale)) ? readdirSync(join(ROOT, locale)).filter((f) => f.endsWith('.ts')).sort() : []);

async function load(locale: string, file: string): Promise<Record<string, string>> {
  const mod = (await import(pathToFileURL(join(ROOT, locale, file)).href)) as { default?: Record<string, string> };
  expect(mod.default, `${locale}/${file} must export default a Record<string,string>`).toBeTypeOf('object');
  return mod.default!;
}
const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

describe('UI i18n namespaces', () => {
  it('ko and en provide the same namespace files', () => {
    expect(list('ko')).toEqual(list('en'));
    expect(list('en')).toContain('shell.ts');
  });

  for (const file of list('en')) {
    const ns = file.replace(/\.ts$/, '');
    it(`${ns}: identical keys, namespace prefix, no empty strings, same placeholders`, async () => {
      const en = await load('en', file);
      const ko = existsSync(join(ROOT, 'ko', file)) ? await load('ko', file) : {};
      const enKeys = Object.keys(en).sort();
      const koKeys = Object.keys(ko).sort();
      expect(koKeys.filter((k) => !(k in en)), `keys only in ko/${file}`).toEqual([]);
      expect(enKeys.filter((k) => !(k in ko)), `keys only in en/${file}`).toEqual([]);
      for (const k of enKeys) {
        expect(k.startsWith(`${ns}.`), `key '${k}' must start with '${ns}.'`).toBe(true);
        expect(typeof en[k] === 'string' && en[k].trim().length > 0, `en '${k}' is empty`).toBe(true);
        expect(typeof ko[k] === 'string' && ko[k].trim().length > 0, `ko '${k}' is empty`).toBe(true);
        expect(params(ko[k]), `placeholders differ for '${k}'`).toBe(params(en[k]));
      }
    });
  }

  it('no key is defined by two namespaces', async () => {
    const seen = new Map<string, string>();
    const dups: string[] = [];
    for (const file of list('en')) for (const k of Object.keys(await load('en', file))) {
      if (seen.has(k)) dups.push(`${k} (${seen.get(k)} / ${file})`);
      seen.set(k, file);
    }
    expect(dups).toEqual([]);
  });
});
