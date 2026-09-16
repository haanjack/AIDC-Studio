#!/usr/bin/env node
// AIDC Studio — publication boundary check (read-only; stream N3, 2026-09-15; LICENSE-AUDIT R-6.1, R-6.3, R-6.4).
//
// Lists the files git WOULD publish (honouring .gitignore, using a throw-away git index outside the repo, so the working
// tree is never modified) and fails when:
//   E1  a private path would be published (data/, assets/, docs/research/, docs/legal working papers, screenshots)
//   E2  a deck/page crop or vendor-derived file name would be published (deck-p*.png, retired content-pack prefix_*, *.cgns)
//   E3  a published file (or a file in apps/web/dist) is byte-identical to a file in the private archive MANIFEST
//   E4  one of our own publishable files is ignored by mistake (generic wide OU rack model/USD/thumbnail, CREDITS.json, notices)
//   E5  the web build lacks THIRD_PARTY_NOTICES.txt (only when apps/web/dist exists)
// and warns (W1) on marker strings in published text files (painted vendor wordmarks, internal URLs, local paths).
//
// Usage: node tools/licenses/check-publication.mjs [--manifest <MANIFEST.tsv>] [--quiet]
// Default manifest: $AIDC_PRIVATE_MANIFEST or ~/aidc-private/neutralization-2026-09-15/MANIFEST.tsv (skipped if absent).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const argVal = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const MANIFEST = argVal('--manifest') ?? process.env.AIDC_PRIVATE_MANIFEST ?? join(homedir(), 'aidc-private/neutralization-2026-09-15/MANIFEST.tsv');
const quiet = args.includes('--quiet');

const errors = [];
const warnings = [];

// ── files git would publish ──
const gitDir = mkdtempSync(join(tmpdir(), 'aidc-pubcheck-'));
const git = (...a) => spawnSync('git', [`--git-dir=${gitDir}/.git`, `--work-tree=${ROOT}`, ...a], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
let published = [];
try {
  if (spawnSync('git', ['init', '-q', gitDir]).status !== 0) throw new Error('git init failed (is git installed?)');
  const r = git('ls-files', '--others', '--exclude-standard', '-z');
  if (r.status !== 0) throw new Error(r.stderr);
  published = r.stdout.split('\0').filter(Boolean).sort();

  const PRIVATE = [/^data\//, /^assets\//, /^docs\/research\//, /^docs\/legal\//, /(^|\/)__screenshots__\//, /^screenshots\//, /(^|\/)__pycache__\//, /(^|\/)node_modules\//, /^apps\/web\/dist\//];
  // the retired content-pack file prefix is built from character codes (P6 term guard: the abbreviation lives in README.md only)
  const PACK_PREFIX = String.fromCharCode(100, 115, 120);
  const VENDOR_NAMES = [/(^|\/)deck-p[^/]*\.png$/i, new RegExp(`(^|/)${PACK_PREFIX}_[^/]*$`, 'i'), /\.cgns$/i];
  for (const f of published) {
    if (PRIVATE.some((re) => re.test(f))) errors.push(`E1 private path would be published: ${f}`);
    if (VENDOR_NAMES.some((re) => re.test(f))) errors.push(`E2 vendor-derived file name would be published: ${f}`);
  }

  const MUST_PUBLISH = ['LICENSE', 'NOTICE', 'TRADEMARKS.md', 'THIRD_PARTY_NOTICES.md', 'apps/web/public/THIRD_PARTY_NOTICES.txt', 'apps/web/public/assets/CREDITS.json',
    'apps/web/public/assets/models/generic_rack_orw_44ou_dlc.glb', 'apps/web/public/assets/thumbs/generic_rack_orw_44ou_dlc.png', 'apps/web/public/assets/usd/Generic/generic_rack_orw_44ou_dlc.usda'];
  for (const f of MUST_PUBLISH) {
    if (!existsSync(join(ROOT, f))) { warnings.push(`W0 expected publishable file is missing: ${f}`); continue; }
    if (git('check-ignore', '-q', '--no-index', f).status === 0) errors.push(`E4 own file is ignored by .gitignore: ${f}`);
  }
} catch (e) {
  errors.push(`git listing failed: ${e.message}`);
} finally {
  rmSync(gitDir, { recursive: true, force: true });
}

// ── byte-identical copies of archived files ──
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const walk = (dir, out = []) => { if (!existsSync(dir)) return out; for (const n of readdirSync(dir)) { const p = join(dir, n); const s = statSync(p); if (s.isDirectory()) walk(p, out); else out.push(p); } return out; };
if (existsSync(MANIFEST)) {
  const archived = new Map();
  for (const line of readFileSync(MANIFEST, 'utf8').split('\n').slice(1)) {
    const [path, sha, bytes, reason] = line.split('\t');
    if (sha && /^[0-9a-f]{64}$/.test(sha) && !/edited in place/.test(reason ?? '')) archived.set(sha, { path, bytes: Number(bytes) });
  }
  // A re-sourced third-party asset can be byte-identical to the archived copy (e.g. the CC0 HDRI regenerated from the
  // original download). It passes when CREDITS.json documents that exact sha256 with a licence.
  try {
    for (const c of JSON.parse(readFileSync(join(ROOT, 'apps/web/public/assets/CREDITS.json'), 'utf8')).assets ?? []) {
      if (c?.sha256 && c?.license) archived.delete(c.sha256);
    }
  } catch { /* no credits file */ }
  const sizes = new Set([...archived.values()].map((v) => v.bytes));
  const candidates = [...published.map((f) => join(ROOT, f)), ...walk(join(ROOT, 'apps/web/dist'))];
  for (const abs of candidates) {
    let st; try { st = statSync(abs); } catch { continue; }
    if (!sizes.has(st.size) || st.size === 0) continue;
    const hit = archived.get(sha256(abs));
    if (hit) errors.push(`E3 ${relative(ROOT, abs)} is identical to archived ${hit.path}`);
  }
} else if (!quiet) {
  warnings.push(`W0 private archive MANIFEST not found (${MANIFEST}); byte-identity check skipped`);
}

// ── web build notices ──
if (existsSync(join(ROOT, 'apps/web/dist/index.html')) && !existsSync(join(ROOT, 'apps/web/dist/THIRD_PARTY_NOTICES.txt'))) errors.push('E5 apps/web/dist/THIRD_PARTY_NOTICES.txt missing (rebuild the web app)');

// ── marker strings in published text ──
const MARKERS = [
  [/['"`]VERTIV\b|Liebert CW['"`]/, 'painted vendor wordmark string'],
  [/NVIDIA CFD colormap/i, 'vendor CFD legend'],
  [/omniverse:\/\//, 'internal Omniverse URL'],
  [/\/home\/[a-z0-9_-]+\//, 'local home path'],
  [/verbatim vendor/i, '"verbatim vendor" wording'],
];
const TEXT = /\.(ts|tsx|js|mjs|cjs|json|md|txt|py|usda|html|css|yml|yaml)$/i;
for (const f of published) {
  if (!TEXT.test(f) || f === 'tools/licenses/check-publication.mjs') continue;
  let text; try { const b = readFileSync(join(ROOT, f)); if (b.length > 4_000_000) continue; text = b.toString('utf8'); } catch { continue; }
  for (const [re, what] of MARKERS) { const m = re.exec(text); if (m) warnings.push(`W1 ${f}:${text.slice(0, m.index).split('\n').length} ${what}`); }
}

if (!quiet) console.log(`published files: ${published.length}`);
for (const w of warnings) console.log(`WARN  ${w}`);
for (const e of errors) console.log(`ERROR ${e}`);
console.log(errors.length ? `FAIL (${errors.length} error(s), ${warnings.length} warning(s))` : `OK (${warnings.length} warning(s))`);
process.exit(errors.length ? 1 : 0);
