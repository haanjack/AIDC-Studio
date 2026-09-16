#!/usr/bin/env node
// AIDC Studio — offline npm dependency license scanner (read-only).
//
// Regenerates, deterministically (sorted rows, no timestamps, content-derived serial number):
//   docs/legal/inventory-npm.csv         one row per package-lock entry (direct + transitive)
//   docs/legal/sbom-npm.cdx.json         CycloneDX 1.5 JSON SBOM
//   docs/legal/web-bundle-modules.json   packages actually rendered into the production web bundle
//
// Inputs: package-lock.json (v3), installed node_modules (license/NOTICE files, package.json),
// Dockerfile (CMD runtime), and a Vite module graph captured by tools/licenses/vite.license-graph.config.mjs.
//
// Usage:
//   node tools/licenses/scan-npm.mjs                       # reuse docs/legal/web-bundle-modules.json
//   node tools/licenses/scan-npm.mjs --graph <module-graph.json>   # refresh bundle data from a captured graph
//   node tools/licenses/scan-npm.mjs --build               # run the scratch vite build into a temp dir first
//   node tools/licenses/scan-npm.mjs --out <dir>           # write elsewhere (default docs/legal)
//
// This is a technical inventory aid, not legal advice.
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdtempSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const SCANNER_VERSION = '1.0.0';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const argVal = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const OUT = resolve(ROOT, argVal('--out') ?? 'docs/legal');
mkdirSync(OUT, { recursive: true });

const lockRaw = readFileSync(join(ROOT, 'package-lock.json'), 'utf8');
const lock = JSON.parse(lockRaw);
if (lock.lockfileVersion < 2) throw new Error('package-lock v2/v3 required');
const L = lock.packages;

// ───────────────────────── helpers ─────────────────────────
const sortObj = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const collapse = (s, n = 200) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const readText = (p, max = 400_000) => { try { const b = readFileSync(p); return b.subarray(0, max).toString('utf8'); } catch { return ''; } };
const nameOfKey = (k) => { const i = k.lastIndexOf('node_modules/'); return i < 0 ? k : k.slice(i + 13); };
const isWorkspaceKey = (k) => k !== '' && !k.includes('node_modules/');

function resolveDep(name, fromKey) {
  let base = fromKey;
  for (;;) {
    const cand = (base ? base + '/' : '') + 'node_modules/' + name;
    if (L[cand] && !(L[cand].link && !L[cand].resolved)) return cand;
    if (L[cand]?.link) return L[cand].resolved; // workspace symlink → workspace key
    if (!base) return undefined;
    const i = base.lastIndexOf('/node_modules/');
    base = i >= 0 ? base.slice(0, i) : '';
  }
}
function depsOf(key, { includeDev = false } = {}) {
  const e = L[key] ?? {};
  const names = { ...e.dependencies, ...e.optionalDependencies, ...e.peerDependencies, ...(includeDev ? e.devDependencies : {}) };
  const out = [];
  for (const n of Object.keys(names).sort()) { const r = resolveDep(n, key); if (r && r !== key) out.push(r); }
  return out;
}
function closure(startKeys) {
  const seen = new Set(); const st = [...startKeys];
  while (st.length) { const k = st.pop(); if (seen.has(k)) continue; seen.add(k); for (const d of depsOf(k)) st.push(d); }
  return seen;
}

// ───────────────────────── license text detection ─────────────────────────
const DETECTORS = [
  ['Apache-2.0', /Apache License[\s\S]{0,40}Version 2\.0/i],
  ['MPL-2.0', /Mozilla Public License,?\s*(Version|v\.?)\s*2\.0/i],
  ['BlueOak-1.0.0', /Blue Oak Model License/i],
  ['AGPL-3.0', /GNU AFFERO GENERAL PUBLIC LICENSE/],
  ['LGPL', /GNU LESSER GENERAL PUBLIC LICENSE/],
  ['GPL-3.0', /GNU GENERAL PUBLIC LICENSE[\s\S]{0,60}Version 3|\bGPL(v| version )3\b/],
  ['GPL-2.0', /GNU GENERAL PUBLIC LICENSE[\s\S]{0,60}Version 2/],
  ['CC0-1.0', /CC0 1\.0 Universal/],
  ['CC-BY-4.0', /Attribution 4\.0 International/],
  ['OFL-1.1', /SIL OPEN FONT LICENSE/i],
  ['Unlicense', /This is free and unencumbered software released into the public domain/i],
  ['MIT', /Permission is hereby granted, free of charge/i],
  ['ISC|0BSD', /Permission to use, copy, modify,? and\/or distribute this software for any\s+purpose with or without fee is hereby granted/i],
  ['BSD', /Redistribution and use in source and binary forms/i],
  ['Zlib', /origin of this software must not be misrepresented/i],
  ['Python-2.0', /PSF LICENSE AGREEMENT|Python Software Foundation License/i],
];
function detectLicenseText(rawText) {
  const text = String(rawText).replace(/[\s*#>]+/g, ' '); // license texts are hard-wrapped / comment-prefixed
  const found = new Set();
  for (const [id, re] of DETECTORS) {
    if (!re.test(text)) continue;
    if (id === 'ISC|0BSD') found.add(/above copyright notice and this permission notice appear/i.test(text) ? 'ISC' : '0BSD');
    else if (id === 'BSD') found.add(/Neither the name|names? of (its|the|any) contributors|endorse or promote/i.test(text) ? 'BSD-3-Clause' : 'BSD-2-Clause');
    else found.add(id);
  }
  if (found.has('GPL-3.0') && found.has('LGPL')) found.delete('GPL-3.0');
  return [...found].sort();
}
function copyrightLines(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!/^(?:(?:Copyright|COPYRIGHT)\s*(?:\([cC]\)|©|\d{4}|[A-Z"])|\([cC]\)\s*\d{4}|©\s*\d{4})/.test(line)) continue;
    if (/\[yyyy\]|\{yyyy\}|<year>|notice|holders? and contributors|copyright owner\]|copyright and related rights|Free Software Foundation, Inc\.|on the Program|copyright in it|Creative Commons/i.test(line)) continue;
    const c = collapse(line, 160);
    if (!out.includes(c)) out.push(c);
    if (out.length >= 3) break;
  }
  return out;
}

// ───────────────────────── SPDX expression handling ─────────────────────────
const FAMILY = {
  'public-domain-like': ['CC0-1.0', 'Unlicense', '0BSD'],
  permissive: ['MIT', 'MIT-0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'Zlib', 'BlueOak-1.0.0', 'Python-2.0', 'BSD-3-Clause-Clear'],
  content: ['CC-BY-3.0', 'CC-BY-4.0', 'OFL-1.1'],
  'weak-copyleft': ['MPL-1.1', 'MPL-2.0', 'LGPL-2.1', 'LGPL-2.1-only', 'LGPL-2.1-or-later', 'LGPL-3.0', 'LGPL-3.0-only', 'LGPL-3.0-or-later', 'EPL-1.0', 'EPL-2.0', 'CDDL-1.0', 'CDDL-1.1'],
  'strong-copyleft': ['GPL-2.0', 'GPL-2.0-only', 'GPL-2.0-or-later', 'GPL-3.0', 'GPL-3.0-only', 'GPL-3.0-or-later', 'AGPL-3.0', 'AGPL-3.0-only', 'AGPL-3.0-or-later'],
  'non-oss': ['SSPL-1.0', 'BUSL-1.1', 'UNLICENSED', 'Elastic-2.0'],
};
const RANK = ['public-domain-like', 'permissive', 'content', 'weak-copyleft', 'strong-copyleft', 'non-oss', 'unknown'];
const familyOfId = (id) => { for (const [f, ids] of Object.entries(FAMILY)) if (ids.includes(id)) return f; return 'unknown'; };
function normalizeDeclared(pj) {
  const lic = pj?.license, lics = pj?.licenses;
  if (typeof lic === 'string') return { raw: lic, expr: lic.trim() };
  if (lic && typeof lic === 'object') return { raw: JSON.stringify(lic), expr: lic.type ?? '' };
  if (Array.isArray(lics) && lics.length) {
    const ids = lics.map((x) => (typeof x === 'string' ? x : x?.type)).filter(Boolean);
    return { raw: JSON.stringify(lics), expr: ids.length > 1 ? `(${ids.join(' OR ')})` : ids[0] ?? '' };
  }
  return { raw: '', expr: '' };
}
function tokens(expr) { return (expr.match(/[A-Za-z0-9.+-]+/g) ?? []).filter((t) => !/^(AND|OR|WITH)$/.test(t)); }
function evaluate(expr) {
  // returns { family, elected } — OR picks the least restrictive option, AND the most restrictive.
  if (!expr) return { family: 'unknown', elected: '' };
  if (/^SEE LICEN[CS]E IN/i.test(expr)) return { family: 'unknown', elected: expr };
  const inner = expr.replace(/^\((.*)\)$/, '$1');
  if (/\sOR\s/.test(inner) && !/\sAND\s/.test(inner)) {
    const opts = inner.split(/\s+OR\s+/).map((s) => s.replace(/[()]/g, '').trim());
    opts.sort((a, b) => RANK.indexOf(familyOfId(a.replace(/\+$/, ''))) - RANK.indexOf(familyOfId(b.replace(/\+$/, ''))));
    return { family: familyOfId(opts[0]), elected: opts[0] };
  }
  const fams = tokens(inner).map((t) => familyOfId(t.replace(/\+$/, '')));
  const worst = fams.sort((a, b) => RANK.indexOf(b) - RANK.indexOf(a))[0] ?? 'unknown';
  return { family: worst, elected: expr };
}

// ───────────────────────── web bundle data ─────────────────────────
const BUNDLE_JSON = join(OUT, 'web-bundle-modules.json');
let graphPath = argVal('--graph');
if (args.includes('--build')) {
  const tmp = mkdtempSync(join(tmpdir(), 'aidc-license-graph-'));
  const r = spawnSync(join(ROOT, 'node_modules/.bin/vite'), ['build', '--config', join(ROOT, 'tools/licenses/vite.license-graph.config.mjs')],
    { cwd: join(ROOT, 'apps/web'), env: { ...process.env, AIDC_LICENSE_GRAPH_OUT: tmp }, stdio: 'inherit' });
  if (r.status !== 0) throw new Error('scratch vite build failed');
  graphPath = join(tmp, 'module-graph.json');
}
function pkgKeyOfModuleId(id) {
  let p = id.replace(/^\0+/, '').replace(/\?.*$/, '');
  if (!p.startsWith(ROOT + '/')) {
    if (/^rolldown[:/]runtime/.test(p)) return { key: 'node_modules/rolldown', file: '(injected runtime)', injected: true };
    if (/^vite\//.test(p)) return { key: 'node_modules/vite', file: `(injected ${p})`, injected: true };
    return undefined;
  }
  p = relative(ROOT, p);
  const i = p.lastIndexOf('node_modules/');
  if (i < 0) { const parts = p.split('/'); return { key: parts.slice(0, 2).join('/'), file: parts.slice(2).join('/'), firstParty: true }; }
  const rest = p.slice(i + 13).split('/');
  const n = rest[0].startsWith('@') ? 2 : 1;
  return { key: p.slice(0, i + 13) + rest.slice(0, n).join('/'), file: rest.slice(n).join('/') };
}
let bundle;
if (graphPath) {
  const g = JSON.parse(readFileSync(graphPath, 'utf8'));
  const acc = {};
  const touch = (k) => (acc[k] ??= { bytes: 0, chunks: new Set(), files: new Set(), injected: false, rendered: false });
  for (const [chunkKey, c] of Object.entries(g.chunks)) {
    if (c.asset) continue;
    const [label, file] = [chunkKey.slice(0, chunkKey.indexOf(':')), chunkKey.slice(chunkKey.indexOf(':') + 1)];
    const chunkName = `${label}:${file.replace(/^assets\//, '').replace(/-[\w-]{8}(?=\.\w+$)/, '')}`;
    for (const [id, len] of Object.entries(c.modules ?? {})) {
      const m = pkgKeyOfModuleId(id); if (!m) continue;
      const a = touch(m.key);
      if (len > 0) { a.bytes += len; a.chunks.add(chunkName); a.files.add(m.file); a.rendered = true; }
      if (m.injected) a.injected = true;
      if (m.firstParty) a.firstParty = true;
    }
  }
  for (const ids of Object.values(g.graphIds ?? {})) for (const id of ids) { const m = pkgKeyOfModuleId(id); if (m && !m.firstParty) touch(m.key); }
  bundle = {};
  for (const [k, a] of Object.entries(acc)) {
    bundle[k] = { status: a.rendered ? (a.injected ? 'injected-runtime' : 'bundled') : 'tree-shaken', bytes: a.bytes, chunks: [...a.chunks].sort(), files: [...a.files].sort() };
  }
  bundle = sortObj(bundle);
  writeFileSync(BUNDLE_JSON, JSON.stringify({
    _comment: 'Packages rendered into the apps/web production bundle (vite build incl. worker sub-builds). status=bundled: code shipped; injected-runtime: bundler runtime helper shipped; tree-shaken: resolved but 0 bytes emitted. Regenerate: node tools/licenses/scan-npm.mjs --build',
    generator: `aidc scan-npm ${SCANNER_VERSION}`,
    lockfileSha256: createHash('sha256').update(lockRaw).digest('hex'),
    packages: bundle,
  }, null, 1) + '\n');
} else if (existsSync(BUNDLE_JSON)) {
  bundle = JSON.parse(readFileSync(BUNDLE_JSON, 'utf8')).packages;
} else {
  console.warn('WARN: no bundle graph; web-bundle columns will be "unknown". Run with --build or --graph.');
  bundle = null;
}

// ───────────────────────── runtime closures ─────────────────────────
const workspaces = Object.keys(L).filter(isWorkspaceKey).sort();
const webProd = closure(depsOf('apps/web'));
const serverProd = closure(depsOf('apps/server'));
const dockerfile = readText(join(ROOT, 'Dockerfile'));
// Only the FINAL stage ends up in the image (multi-stage builds: build tools stay in earlier stages).
const dockerFinal = dockerfile.split(/^FROM\s/m).pop() ?? '';
const cmdLine = (dockerFinal.match(/^CMD .*$/m) ?? [''])[0];
const containerCmd = new Set();
if (/\btsx\b/.test(cmdLine)) for (const k of closure([resolveDep('tsx', '')].filter(Boolean))) containerCmd.add(k);
const dockerInstallsDev = /npm ci(?![^\n]*(--omit[= ]dev|--production|--only[= ]prod))/.test(dockerFinal);
const dockerServerOnly = /npm ci[^\n]*(--workspace[= ]|-w\s+)@aidc\/server/.test(dockerFinal);
const directOf = {};
for (const ws of ['', ...workspaces]) {
  const e = L[ws] ?? {};
  for (const [field, tag] of [['dependencies', 'dep'], ['devDependencies', 'dev'], ['optionalDependencies', 'opt'], ['peerDependencies', 'peer']]) {
    for (const n of Object.keys(e[field] ?? {})) {
      const r = resolveDep(n, ws); if (!r) continue;
      (directOf[r] ??= []).push(`${ws || 'root'}:${tag}`);
    }
  }
}

// ───────────────────────── per-package scan ─────────────────────────
const LICENSE_FILE = /^(licen[cs]e|copying|unlicense)([.-].*)?$/i;
const NOTICE_FILE = /^(notice|thirdpartynotice)/i;
function scanDir(dir) {
  const r = { licenseFiles: [], noticeFiles: [], detected: [], copyright: [], noticeExcerpt: '', readmeLicense: '' };
  if (!existsSync(dir)) return r;
  let names = [];
  try { names = readdirSync(dir).sort(); } catch { return r; }
  let licText = '';
  for (const n of names) {
    const p = join(dir, n);
    try { if (!statSync(p).isFile()) continue; } catch { continue; }
    if (LICENSE_FILE.test(n)) { r.licenseFiles.push(n); licText += '\n' + readText(p); }
    else if (NOTICE_FILE.test(n)) { r.noticeFiles.push(n); if (!r.noticeExcerpt) r.noticeExcerpt = collapse(readText(p, 4000), 300); }
  }
  if (licText) { r.detected = detectLicenseText(licText); r.copyright = copyrightLines(licText); }
  if (!r.licenseFiles.length) {
    const readme = names.find((n) => /^readme/i.test(n));
    if (readme) {
      const t = readText(join(dir, readme));
      const m = t.match(/^#{1,6}[^\n]{0,8}licen[cs]e[^\n]{0,20}\n([\s\S]{0,400})/im);
      if (m) { r.readmeLicense = collapse(m[1].split(/\n#{1,6}\s/)[0], 200); r.detected = detectLicenseText(m[1]); }
      if (!r.copyright.length) r.copyright = copyrightLines(t);
    }
  }
  return r;
}
function embeddedNotices(dir, files) {
  const out = [];
  for (const f of files ?? []) {
    if (!f || f.startsWith('(')) continue;
    const t = readText(join(dir, f), 200_000);
    const re = /\/\*[!*][\s\S]{0,1500}?\*\//g; let m;
    while ((m = re.exec(t))) {
      if (!/@license|copyright|\(c\)\s*\d{4}|licen[cs]ed under/i.test(m[0])) continue;
      const c = `${f}: ${collapse(m[0].replace(/^\/\*[!*]+|\*\/$/g, '').replace(/^\s*\*\s?/gm, ''), 180)}`;
      if (!out.includes(c)) out.push(c);
      if (out.length >= 3) break;
    }
  }
  return out;
}
const repoUrl = (r) => { const u = typeof r === 'string' ? r : r?.url; if (!u) return ''; return u.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/\.git$/, '').replace(/^github:/, 'https://github.com/'); };
const authorStr = (a) => (typeof a === 'string' ? a : a?.name ? `${a.name}${a.email ? ` <${a.email}>` : ''}` : '');

const rootPj = JSON.parse(readText(join(ROOT, 'package.json')));
const rootLicense = scanDir(ROOT);
const rows = [];
for (const key of Object.keys(L).sort()) {
  if (key === '') continue;
  const e = L[key];
  if (e.link) continue; // node_modules/@aidc/* symlinks — represented by the workspace rows
  const ws = isWorkspaceKey(key);
  const dir = join(ROOT, key);
  const installed = existsSync(join(dir, 'package.json'));
  const pj = installed ? JSON.parse(readText(join(dir, 'package.json'))) : {};
  const name = ws ? pj.name ?? e.name ?? key : nameOfKey(key);
  const version = e.version ?? pj.version ?? '';
  let { raw, expr } = normalizeDeclared(installed ? pj : { license: e.license });
  if (!raw && e.license) ({ raw, expr } = normalizeDeclared({ license: e.license }));
  const scan = installed ? scanDir(dir) : { licenseFiles: [], noticeFiles: [], detected: [], copyright: [], noticeExcerpt: '', readmeLicense: '' };
  const flags = [];
  let licenseSource = 'package.json';
  if (ws) {
    if (!expr) { expr = 'Apache-2.0'; licenseSource = 'repo root LICENSE (workspace has no license field; private:true)'; flags.push('FIRST_PARTY'); }
    scan.detected = rootLicense.detected; scan.copyright = scan.copyright.length ? scan.copyright : [`NOTICE: ${collapse(readText(join(ROOT, 'NOTICE')).split('\n')[1] ?? '', 80)}`];
  } else if (!expr) {
    flags.push('MISSING_LICENSE_FIELD');
    if (scan.detected.length === 1) { expr = scan.detected[0]; licenseSource = `inferred from ${scan.licenseFiles.join('|') || 'README'} text`; }
    else licenseSource = 'none';
  } else if (/^SEE LICEN[CS]E IN/i.test(expr)) { flags.push('SEE_LICENSE_IN'); }
  if (/\sOR\s/.test(expr)) flags.push('DUAL_OR_MULTI_LICENSE');
  if (/\sAND\s/.test(expr)) flags.push('CONJUNCTIVE_LICENSE');
  let textCheck = '';
  if (ws) textCheck = 'first-party: covered by repo root LICENSE';
  else if (!installed) textCheck = 'not installed (optional platform binary for another OS/CPU)';
  else if (!scan.licenseFiles.length && !scan.readmeLicense) { textCheck = 'NO license file and no README license section'; flags.push('NO_LICENSE_TEXT'); }
  else {
    const decl = new Set(tokens(expr).map((t) => t.replace(/\+$/, '').replace(/-(only|or-later)$/, '')));
    const det = scan.detected.map((d) => d.replace(/-(only|or-later)$/, ''));
    if (!det.length) textCheck = scan.licenseFiles.length ? 'license file present; text not recognised' : 'README license section only';
    else if (det.some((d) => decl.has(d))) textCheck = `ok (${det.join('+')}${scan.licenseFiles.length ? '' : ' via README'})`;
    else { textCheck = `MISMATCH: declared ${expr} but text is ${det.join('+')}`; flags.push('LICENSE_TEXT_MISMATCH'); }
    if (!scan.licenseFiles.length) flags.push('NO_LICENSE_FILE');
  }
  const { family, elected } = evaluate(expr);
  if (family === 'weak-copyleft' || family === 'strong-copyleft' || family === 'non-oss' || family === 'unknown') flags.push(`FAMILY_${family.toUpperCase()}`);
  if (scan.noticeFiles.length) flags.push('HAS_NOTICE_FILE');

  const b = bundle ? bundle[key] : undefined;
  const inWeb = bundle === null ? 'unknown' : b ? b.status : 'no';
  const server = ws ? key === 'apps/server' || serverProd.has(key) : serverProd.has(key);
  const container = containerCmd.has(key);
  const isDev = !!(e.dev || (e.devOptional && !webProd.has(key) && !serverProd.has(key)));
  let shipClass;
  if (ws) shipClass = 'first-party-workspace';
  else if (!installed && e.optional) shipClass = 'optional-not-installed';
  else if (inWeb === 'bundled' || inWeb === 'injected-runtime') shipClass = 'web-bundle';
  else if (server) shipClass = 'server-runtime';
  else if (container) shipClass = 'container-runtime';
  else if (isDev) shipClass = 'dev-build-only';
  else if (webProd.has(key)) shipClass = 'web-prod-dep-not-bundled';
  else shipClass = 'prod-other';
  const inImage = ws ? 'yes (source)' : installed
    ? (dockerInstallsDev ? 'yes' : dockerServerOnly ? (server || container ? 'yes' : 'no') : !isDev ? 'yes' : 'no')
    : (e.optional ? 'platform-dependent' : 'no');
  const embedded = installed && b && b.files?.length ? embeddedNotices(dir, b.files) : [];
  rows.push({
    lock_path: key, name, version, installed: installed ? 'yes' : 'no',
    direct_of: (directOf[key] ?? []).sort().join(' '),
    ship_class: shipClass, in_web_bundle: inWeb, web_bundle_bytes: b ? b.bytes : '', web_bundle_chunks: b ? b.chunks.join(' ') : '',
    server_runtime: server ? 'yes' : 'no', container_cmd_runtime: container ? 'yes' : 'no', in_container_image: inImage,
    dev_only: isDev ? 'yes' : 'no', optional: e.optional ? 'yes' : 'no',
    declared_license_raw: raw, spdx_expression: expr, license_source: licenseSource, license_family: family, elected_license: elected,
    license_files: scan.licenseFiles.join('|'), detected_license_text: scan.detected.join('+'), text_check: textCheck,
    copyright: scan.copyright.join(' | '), author: authorStr(pj.author),
    notice_files: scan.noticeFiles.join('|'), notice_excerpt: scan.noticeExcerpt,
    embedded_notices: embedded.join(' || '), readme_license: scan.readmeLicense,
    repository: repoUrl(pj.repository) || pj.homepage || '', resolved: e.resolved ?? '', integrity: e.integrity ?? '',
    flags: [...new Set(flags)].sort().join(' '),
  });
}

// ───────────────────────── CSV ─────────────────────────
const COLS = Object.keys(rows[0]);
const csvCell = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
writeFileSync(join(OUT, 'inventory-npm.csv'), [COLS.join(','), ...rows.map((r) => COLS.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n');

// ───────────────────────── CycloneDX 1.5 ─────────────────────────
const refOf = (key) => (isWorkspaceKey(key) ? `workspace:${key}` : `npm:${key}`);
const purl = (name, version) => `pkg:npm/${name.startsWith('@') ? '%40' + name.slice(1) : name}@${version}`;
function hashes(integrity) {
  const out = [];
  for (const part of String(integrity ?? '').split(/\s+/).filter(Boolean)) {
    const m = part.match(/^(sha512|sha384|sha256|sha1)-(.+)$/); if (!m) continue;
    out.push({ alg: { sha512: 'SHA-512', sha384: 'SHA-384', sha256: 'SHA-256', sha1: 'SHA-1' }[m[1]], content: Buffer.from(m[2], 'base64').toString('hex') });
  }
  return out;
}
function cdxLicenses(expr) {
  if (!expr) return undefined;
  if (/\s(AND|OR|WITH)\s/.test(expr)) return [{ expression: expr }];
  if (familyOfId(expr) !== 'unknown') return [{ license: { id: expr } }];
  return [{ license: { name: expr } }];
}
const sha = createHash('sha256').update(lockRaw).update(SCANNER_VERSION).digest('hex');
const serial = `urn:uuid:${sha.slice(0, 8)}-${sha.slice(8, 12)}-5${sha.slice(13, 16)}-${((parseInt(sha[16], 16) & 0x3) | 0x8).toString(16)}${sha.slice(17, 20)}-${sha.slice(20, 32)}`;
const byKey = Object.fromEntries(rows.map((r) => [r.lock_path, r]));
const components = rows.map((r) => {
  const ws = isWorkspaceKey(r.lock_path);
  const c = {
    type: ws ? 'application' : 'library',
    'bom-ref': refOf(r.lock_path),
    ...(r.name.startsWith('@') ? { group: r.name.split('/')[0], name: r.name.split('/')[1] } : { name: r.name }),
    version: r.version,
    scope: r.ship_class === 'dev-build-only' ? 'excluded' : r.ship_class === 'optional-not-installed' ? 'optional' : 'required',
  };
  const lic = cdxLicenses(r.spdx_expression); if (lic) c.licenses = lic;
  if (!ws) c.purl = purl(r.name, r.version);
  const h = hashes(r.integrity); if (h.length) c.hashes = h;
  const refs = [];
  if (r.resolved && /^https?:/.test(r.resolved)) refs.push({ type: 'distribution', url: r.resolved });
  if (r.repository && /^https?:/.test(r.repository)) refs.push({ type: 'vcs', url: r.repository });
  if (refs.length) c.externalReferences = refs;
  if (r.copyright) c.evidence = { copyright: r.copyright.split(' | ').map((text) => ({ text })) };
  c.properties = [
    ['cdx:npm:package:path', r.lock_path],
    ['cdx:npm:package:development', r.dev_only === 'yes' ? 'true' : 'false'],
    ['aidc:ship-class', r.ship_class],
    ['aidc:in-web-bundle', r.in_web_bundle],
    ['aidc:server-runtime', r.server_runtime],
    ['aidc:in-container-image', r.in_container_image],
    ['aidc:license-family', r.license_family],
    ['aidc:license-source', r.license_source],
    ['aidc:license-text-check', r.text_check],
    ...(r.elected_license && r.elected_license !== r.spdx_expression ? [['aidc:elected-license', r.elected_license]] : []),
    ...(r.license_files ? [['aidc:license-files', r.license_files]] : []),
    ...(r.notice_files ? [['aidc:notice-files', r.notice_files]] : []),
    ...(r.flags ? [['aidc:flags', r.flags]] : []),
  ].map(([name, value]) => ({ name, value: String(value) }));
  return c;
});
const dependencies = [
  { ref: 'aidc-studio', dependsOn: [...new Set(depsOf('', { includeDev: true }).concat(workspaces).map(refOf))].filter((x) => byKey[x.replace(/^(npm|workspace):/, '')]).sort() },
  ...rows.map((r) => ({ ref: refOf(r.lock_path), dependsOn: [...new Set(depsOf(r.lock_path, { includeDev: isWorkspaceKey(r.lock_path) }).filter((k) => byKey[k]).map(refOf))].sort() })),
];
const sbom = {
  bomFormat: 'CycloneDX', specVersion: '1.5', serialNumber: serial, version: 1,
  metadata: {
    tools: { components: [{ type: 'application', name: 'aidc-scan-npm', version: SCANNER_VERSION, description: 'tools/licenses/scan-npm.mjs (offline; package-lock.json + node_modules + vite module graph)' }] },
    component: { type: 'application', 'bom-ref': 'aidc-studio', name: rootPj.name, version: rootPj.version, licenses: [{ license: { id: 'Apache-2.0' } }], description: rootPj.description },
    properties: [
      { name: 'aidc:lockfile-sha256', value: createHash('sha256').update(lockRaw).digest('hex') },
      { name: 'aidc:note', value: 'Technical inventory, not legal advice. scope=excluded means dev/build-only (not in the web bundle or server runtime), although the current Dockerfile (npm ci + COPY /app) still places those packages in the container image.' },
    ],
  },
  components,
  dependencies,
};
writeFileSync(join(OUT, 'sbom-npm.cdx.json'), JSON.stringify(sbom, null, 2) + '\n');

// ───────────────────────── draft third-party notices ─────────────────────────
// Verified upstream facts for packages whose npm tarball lacks (or contradicts) license evidence.
// Each entry names its primary source; re-verify when the version changes.
const UPSTREAM = {
  '@react-three/fiber': { copyright: 'Copyright (c) 2019-2025 Poimandres', note: 'npm tarball has no LICENSE file; upstream https://raw.githubusercontent.com/pmndrs/react-three-fiber/master/LICENSE (MIT) checked 2026-09-15' },
  n8ao: { note: 'package.json says ISC, but the shipped LICENSE and README are CC0-1.0 (upstream https://raw.githubusercontent.com/N8python/n8ao/master/LICENSE checked 2026-09-15). Treat as CC0-1.0 (no attribution required, no patent licence); confirm with author or counsel.' },
};
const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;
{
  const shipped = rows.filter((r) => ['web-bundle', 'server-runtime', 'container-runtime'].includes(r.ship_class));
  const section = (title, list) => [`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`, ...list.map((r) => {
    const up = UPSTREAM[r.name];
    const cr = r.copyright || up?.copyright || (r.author ? `author: ${r.author} (no copyright line in license file)` : '(no copyright line in package; see repository)');
    return `- ${r.name}@${r.version}  |  ${r.spdx_expression}${r.elected_license !== r.spdx_expression ? `  (used under: ${r.elected_license})` : ''}  |  ${cr}  |  ${r.repository}${up ? `\n    NOTE: ${up.note}` : ''}`;
  })].join('\n');
  const texts = new Map();
  for (const r of shipped) {
    const dir = join(ROOT, r.lock_path);
    let body = r.license_files ? r.license_files.split('|').map((f) => readText(join(dir, f), 100_000).trim()).join('\n\n') : '';
    if (!body && /^MIT$/.test(r.spdx_expression)) body = `${UPSTREAM[r.name]?.copyright ?? '(copyright holder: see repository)'}\n\n${MIT_TEXT}\n\n[standard MIT text supplied by scanner — package ships no LICENSE file]`;
    if (!body) body = `[no license text in package — declared ${r.spdx_expression}; obtain from ${r.repository}]`;
    const h = createHash('sha256').update(body.replace(/\s+/g, ' ')).digest('hex');
    if (!texts.has(h)) texts.set(h, { body, pkgs: [] });
    texts.get(h).pkgs.push(`${r.name}@${r.version}`);
  }
  const ordered = [...texts.values()].sort((a, b) => (a.pkgs[0] < b.pkgs[0] ? -1 : 1));
  const out = [
    'AIDC Studio — THIRD-PARTY SOFTWARE NOTICES (npm)  —  DRAFT, NOT YET REVIEWED BY COUNSEL',
    `Generated by tools/licenses/scan-npm.mjs ${SCANNER_VERSION} from package-lock.json sha256 ${createHash('sha256').update(lockRaw).digest('hex')}`,
    'Intended to be shipped next to the built web app (e.g. dist/third-party-licenses.txt) and inside any server/container distribution.',
    'Dev/build-only tools are not listed here unless they inject runtime code into the bundle; see docs/legal/inventory-npm.csv for all packages.',
    section('A. Code included in the production web bundle (apps/web)', shipped.filter((r) => r.ship_class === 'web-bundle')),
    section('B. Server runtime dependencies (apps/server, executed from node_modules)', shipped.filter((r) => r.ship_class === 'server-runtime')),
    section('C. Container start-up runtime (Dockerfile CMD: npx tsx)', shipped.filter((r) => r.ship_class === 'container-runtime')),
    `\n${'='.repeat(78)}\nD. License texts\n${'='.repeat(78)}`,
    ...ordered.map((t) => `\n----- ${t.pkgs.join(', ')} -----\n\n${t.body}\n`),
  ].join('\n');
  writeFileSync(join(OUT, 'THIRD-PARTY-NOTICES-npm.draft.txt'), out + '\n');
}

// ───────────────────────── shipped notices (--notices) ─────────────────────────
// Writes the RELEASE notices from the same rows (stream N3, 2026-09-15):
//   THIRD_PARTY_NOTICES.md                      web bundle + server runtime + other shipped components + licence texts
//   apps/web/public/THIRD_PARTY_NOTICES.txt     web part only; Vite copies it to the dist root (linked from About)
// Run after `--build` so bundle membership is current:  node tools/licenses/scan-npm.mjs --build --out <scratch> --notices
if (args.includes('--notices')) {
  const lockSha = createHash('sha256').update(lockRaw).digest('hex');
  const web = rows.filter((r) => r.ship_class === 'web-bundle');
  const server = rows.filter((r) => r.ship_class === 'server-runtime' || r.ship_class === 'container-runtime');
  const pako = rows.find((r) => r.name === 'pako' && byKey['node_modules/jszip'] && (L['node_modules/jszip']?.dependencies ?? {}).pako);
  const asUsed = (r) => (r.name === 'n8ao' ? 'CC0-1.0' : r.elected_license && r.elected_license !== r.spdx_expression ? `${r.elected_license} (elected from ${r.spdx_expression})` : r.spdx_expression);
  const holder = (r) => (r.name === 'n8ao' ? 'none (CC0-1.0 public-domain dedication)' : r.copyright || UPSTREAM[r.name]?.copyright || (r.author ? `author: ${r.author}` : 'see repository'));
  const md = (s) => String(s).replace(/\|/g, '\\|');
  const licenceBody = (r) => {
    const dir = join(ROOT, r.lock_path);
    let body = r.license_files ? r.license_files.split('|').map((f) => readText(join(dir, f), 100_000).trim()).join('\n\n') : '';
    if (!body && /^MIT$/.test(r.spdx_expression)) body = `${UPSTREAM[r.name]?.copyright ?? '(copyright holder: see repository)'}\n\n${MIT_TEXT}`;
    return body || `[no licence text in the package — declared ${r.spdx_expression}; see ${r.repository}]`;
  };
  const groupTexts = (list) => {
    const m = new Map();
    for (const r of list) {
      const body = licenceBody(r);
      const h = createHash('sha256').update(body.replace(/\s+/g, ' ')).digest('hex');
      if (!m.has(h)) m.set(h, { body, pkgs: [] });
      m.get(h).pkgs.push(`${r.name}@${r.version}`);
    }
    return [...m.values()].sort((a, b) => (a.pkgs[0] < b.pkgs[0] ? -1 : 1));
  };
  let credits = [];
  try { credits = JSON.parse(readText(join(ROOT, 'apps/web/public/assets/CREDITS.json'))).assets ?? []; } catch { credits = []; }
  // only third-party assets need a notice; AIDC Studio's own generated models/USD/thumbnails are listed in CREDITS.json only
  credits = credits.filter((c) => !/AIDC Studio original/i.test(String(c.license ?? '')));
  // third-party code/data embedded in our own source files (not an npm package)
  const EMBEDDED = [{ name: 'Turbo colormap lookup values', license: 'Apache-2.0', holder: 'Copyright 2019 Google LLC (author Anton Mikhailov)', where: 'apps/web/src/viewer/colormap.ts (THERMAL_COLORMAP control points, web bundle)', url: 'https://gist.github.com/mikhailov-work/6a308c20e494d9e0ccc29036b28faa7a', note: '17 control points sampled from the 256-entry sRGB table; Apache License 2.0 text as in LICENSE' }];
  const creditLine = (c) => `${c.title ?? c.name ?? c.path} (${c.path ?? ''}) — ${[].concat(c.authors ?? c.author ?? []).join(', ')}; ${c.license ?? 'licence not stated'}; ${c.sourcePage ?? c.sourceUrl ?? ''}${c.modified ? '; modified (resized) for AIDC Studio' : ''}`;
  const ELECTIONS = [
    'JSZip is dual-licensed (MIT OR GPL-3.0-or-later). AIDC Studio uses JSZip under the MIT License only.',
    'n8ao is dedicated to the public domain under CC0 1.0 Universal (its package.json "ISC" field is incorrect; the shipped LICENSE and upstream are CC0-1.0). CC0 grants no patent or trademark rights.',
    ...(pako ? [`pako@${pako.version} (${pako.spdx_expression.replace(/^\((.*)\)$/, '$1')}) is embedded in the JSZip browser build (jszip/dist/jszip.min.js) and ships in the web bundle; the API server loads JSZip and pako from node_modules as well.`] : []),
  ];

  // ── THIRD_PARTY_NOTICES.md ──
  const table = (list) => ['| Package | Version | License (as used) | Copyright | Source |', '|---|---|---|---|---|',
    ...list.map((r) => `| ${md(r.name)} | ${r.version} | ${md(asUsed(r))} | ${md(holder(r))} | ${r.repository} |`)].join('\n');
  const mdOut = [
    '# AIDC Studio — Third-Party Notices',
    '',
    `AIDC Studio is licensed under the Apache License 2.0 (see \`LICENSE\` and \`NOTICE\`). This file lists the third-party components that are **shipped**: code in the production web bundle, the API server's runtime dependencies, and other components in the container image or the web build. Development and build-only tools are not shipped and are not listed.`,
    '',
    `Generated by \`tools/licenses/scan-npm.mjs --build --notices\` (scanner ${SCANNER_VERSION}) from \`package-lock.json\` sha256 \`${lockSha}\`. Regenerate before every release. Technical inventory, not legal advice.`,
    '',
    '## Licence elections and notes',
    '',
    ...ELECTIONS.map((e) => `- ${e}`),
    '',
    `## A. Code included in the production web bundle (\`apps/web/dist\`)`,
    '',
    'The minifier removes most original headers, so this list and the licence texts in §D are the attribution. The same information ships as `THIRD_PARTY_NOTICES.txt` at the root of the web build and is linked from the About dialog.',
    '',
    table(pako ? [...web, pako] : web),
    '',
    '## B. API server runtime dependencies (`apps/server`)',
    '',
    'Installed from npm into the container image (`npm ci --omit=dev --workspace @aidc/server`) and executed from `node_modules`.',
    '',
    table(server.filter((r) => r !== pako)),
    '',
    '## C. Other shipped components',
    '',
    '| Component | License | Where | Notes |',
    '|---|---|---|---|',
    '| Node.js 24 runtime (`node:24-slim` base image) | MIT, plus the licences of its bundled dependencies | container image | Licence: https://github.com/nodejs/node/blob/main/LICENSE. Debian packages of the base image carry their copyright files under `/usr/share/doc/*/copyright`. |',
    ...EMBEDDED.map((e) => `| ${md(e.name)} | ${e.license} | ${md(e.where)} | ${md(e.holder)}; ${e.url}; ${md(e.note)} |`),
    ...credits.map((c) => `| ${md(c.title ?? c.path)} | ${md(c.license ?? '')} | \`apps/web/public/assets/${md(c.path ?? '')}\` (web build) | ${md([].concat(c.authors ?? []).join(', '))}; ${c.sourcePage ?? c.sourceUrl ?? ''}${c.modified ? '; modified (resized)' : ''} |`),
    '',
    'All other 3D models, thumbnails, USD files and textures in the web build were created for AIDC Studio (see `apps/web/public/assets/CREDITS.json`). No vendor-supplied models, logos, photos or documents are included; see `TRADEMARKS.md`.',
    '',
    '## D. Licence texts',
    '',
    ...groupTexts([...web, ...server]).flatMap((t, i) => [`### D.${i + 1} ${t.pkgs.join(', ')}`, '', '```text', t.body.replace(/```/g, "'''"), '```', '']),
  ].join('\n');
  writeFileSync(join(ROOT, 'THIRD_PARTY_NOTICES.md'), mdOut + '\n');

  // ── apps/web/public/THIRD_PARTY_NOTICES.txt (web build only) ──
  const rule = '='.repeat(78);
  const webList = pako ? [...web, pako] : web;
  const txtOut = [
    'AIDC Studio — THIRD-PARTY NOTICES (web application)',
    rule,
    'AIDC Studio is licensed under the Apache License 2.0. This web application includes the third-party',
    'software listed below. Their copyright notices and licence texts follow. Server and container',
    'components are listed in THIRD_PARTY_NOTICES.md in the source and container distributions.',
    `Generated by tools/licenses/scan-npm.mjs ${SCANNER_VERSION}; package-lock.json sha256 ${lockSha}.`,
    '',
    ...ELECTIONS.map((e) => `* ${e}`),
    '',
    rule, 'A. Components in the web bundle', rule,
    ...webList.map((r) => `- ${r.name}@${r.version} | ${asUsed(r)} | ${holder(r)} | ${r.repository}`),
    ...EMBEDDED.map((e) => `- ${e.name} | ${e.license} | ${e.holder} | ${e.url} | ${e.note}`),
    '',
    rule, 'B. Bundled assets from third parties', rule,
    ...(credits.length ? credits.map((c) => `- ${creditLine(c)}`) : ['- none']),
    'All other models, thumbnails and textures were created for AIDC Studio.',
    '',
    rule, 'C. Licence texts', rule,
    ...groupTexts(webList).map((t) => `\n----- ${t.pkgs.join(', ')} -----\n\n${t.body}\n`),
  ].join('\n');
  mkdirSync(join(ROOT, 'apps/web/public'), { recursive: true });
  writeFileSync(join(ROOT, 'apps/web/public/THIRD_PARTY_NOTICES.txt'), txtOut + '\n');
  console.warn(`notices: web ${webList.length}, server ${server.filter((r) => r !== pako).length}, asset credits ${credits.length}`);
}

// ───────────────────────── summary ─────────────────────────
const count = (f) => rows.reduce((m, r) => ((m[r[f]] = (m[r[f]] ?? 0) + 1), m), {});
console.log(JSON.stringify({ rows: rows.length, ship_class: sortObj(count('ship_class')), license_family: sortObj(count('license_family')), flagged: rows.filter((r) => /MISMATCH|MISSING|NO_LICENSE_TEXT|COPYLEFT|UNKNOWN|NON-OSS|NOTICE/.test(r.flags)).map((r) => `${r.name}@${r.version} [${r.ship_class}] ${r.flags}`) }, null, 2));
