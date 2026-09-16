import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildTestKitModel, createNvidiaReferenceProject, findCatalogItem, generateTestPlan, type GeneratedFile } from '../src/index.ts';
import { tagBalance } from './docs-helpers.ts';
import { nosFixture } from './nos-fixtures.ts';

const fx = nosFixture();
const kit = generateTestPlan(fx.project, fx.analysis, { locale: 'en', cableSchedule: fx.rows, ipPlan: fx.plan });
const kitKo = generateTestPlan(fx.project, fx.analysis, { locale: 'ko', cableSchedule: fx.rows, ipPlan: fx.plan });
const get = (files: GeneratedFile[], p: string) => files.find((f) => f.path === p)?.content ?? '';
const dir = mkdtempSync(join(tmpdir(), 'aidc-testkit-'));
for (const f of kit) {
  mkdirSync(dirname(join(dir, f.path)), { recursive: true });
  writeFileSync(join(dir, f.path), f.content);
}
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const hasPython = spawnSync('python3', ['--version']).status === 0;

describe('test plan — layout', () => {
  it('has every stage, the pytest skeleton, inventory and README', () => {
    const paths = kit.map((f) => f.path);
    for (const p of ['README.html', 'common.sh', 'run_all.sh', 'pytest.ini', 'conftest.py', 'lib/parsers.py', 'lib/results.py', 'inventory/expected.json', 'inventory/hostfiles/single-leaf.txt', 'inventory/hostfiles/cross-spine.txt', 'inventory/hostfiles/bisection-pairs.txt', 'inventory/expected-links.csv']) expect(paths).toContain(p);
    for (const stage of ['00-inventory', '10-links', '20-rdma', '30-collectives', '40-node', '50-storage', '60-thermal-power']) {
      expect(paths.some((p) => p.startsWith(`${stage}/`) && p.endsWith('.sh')), stage).toBe(true);
      expect(paths.some((p) => p.startsWith(`${stage}/test_`) && p.endsWith('.py')), stage).toBe(true);
    }
    for (const f of kit) expect(f.content, f.path).not.toMatch(/undefined|NaN|\[object/);
  });

  it('shell scripts pass bash -n', () => {
    for (const f of kit.filter((x) => x.path.endsWith('.sh'))) {
      const r = spawnSync('bash', ['-n', join(dir, f.path)], { encoding: 'utf8' });
      expect(r.status, `${f.path}: ${r.stderr}`).toBe(0);
    }
  });

  it.skipIf(!hasPython)('python files pass py_compile and the parser computes η from a log', () => {
    const py = kit.filter((x) => x.path.endsWith('.py')).map((x) => join(dir, x.path));
    const r = spawnSync('python3', ['-m', 'py_compile', ...py], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const log = [
      '# Collective test starting: all_reduce_perf',
      '#       size         count      type   redop    root     time   algbw   busbw #wrong     time   algbw   busbw #wrong',
      ' 1073741824     268435456     float     sum      -1    19000   56.51  47.50      0    19010   56.48  47.48      0',
      ' 2147483648     536870912     float     sum      -1    38000   56.51  48.00      0    38010   56.48  47.98      0',
      ' 4294967296    1073741824     float     sum      -1    76000   56.51  48.50      0    76010   56.48  48.48      0',
      '# Avg bus bandwidth    : 12.34',
    ].join('\n');
    writeFileSync(join(dir, 'sample.log'), log);
    const code = 'import sys; sys.path.insert(0, sys.argv[1]); from lib.parsers import parse_nccl_text, plateau_busbw, eta_bus; p = parse_nccl_text(open(sys.argv[2]).read()); v, f = plateau_busbw(p["rows"]); print("%.4f %.4f %s" % (v, eta_bus(v, 400), p["collective"]))';
    const out = spawnSync('python3', ['-c', code, dir, join(dir, 'sample.log')], { encoding: 'utf8' });
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout.trim()).toBe('48.0000 0.9600 all_reduce_perf');
  });
});

describe('test plan — η measurement kit', () => {
  const exp = JSON.parse(get(kit, 'inventory/expected.json'));
  const hosts = (p: string) => get(kit, p).split('\n').filter((l) => l && !l.startsWith('#'));

  it('uses MOD gpn split, mpirun and srun forms, logs/ output and η formulas', () => {
    const mp = get(kit, '30-collectives/eta_mpirun.sh');
    expect(mp).toContain(`NCCL_TESTS_SPLIT="MOD ${exp.gpusPerNode}"`);
    expect(mp).toMatch(/mpirun -np .* -N "\$\{GPN\}" --hostfile/);
    expect(mp).toContain('for scope in single-leaf cross-spine');
    expect(mp).toContain('${OUT}/${coll}_${scope}.log');
    expect(mp).toContain('NCCL_IB_GID_INDEX'); // RoCE fixture
    expect(get(kit, '30-collectives/_eta_srun.sh')).toContain('srun -N "${N}" --ntasks-per-node="${GPN}"');
    const readme = get(kit, 'README.html');
    expect(readme).toContain('η_fabric = η_bus(cross-spine) ÷ η_bus(single-leaf)');
    expect(readme).toContain('Network panel η calibration box');
    expect(exp.predicted.idealGBps).toBe(exp.nicGbps / 8);
  });

  it('single-leaf hosts share one leaf; cross-spine hosts alternate leaves', () => {
    const model = buildTestKitModel(fx.project, fx.analysis, fx.plan, fx.rows);
    const leafOf = new Map(model.nodes.map((n) => [n.hostname, n.leafByNic.be0]));
    const single = hosts('inventory/hostfiles/single-leaf.txt');
    expect(single.length).toBeGreaterThanOrEqual(2);
    expect(new Set(single.map((h) => leafOf.get(h))).size).toBe(1);
    const cross = hosts('inventory/hostfiles/cross-spine.txt');
    expect(cross.length).toBe(single.length);
    for (let i = 1; i < cross.length; i++) expect(leafOf.get(cross[i])).not.toBe(leafOf.get(cross[i - 1]));
    const pairs = hosts('inventory/hostfiles/bisection-pairs.txt').map((l) => l.split(' '));
    for (const [s, c] of pairs) expect(leafOf.get(s)).not.toBe(leafOf.get(c));
  });

  it('every threshold carries a source type; NVIDIA uses the predicted busbw × 0.9 assumption', () => {
    const allowed = ['measured-paper', 'vendor-claim', 'acceptance-threshold', 'standard', 'official-config', 'derived', 'estimate'];
    for (const t of exp.thresholds) {
      expect(allowed, t.id).toContain(t.sourceType);
      expect(t.source.length, t.id).toBeGreaterThan(0);
    }
    expect(exp.vendor).toBe('nvidia');
    expect(exp.tool).toBe('nccl-tests');
    const cross = exp.thresholds.find((t: { id: string }) => t.id === 'collectives.cross-spine');
    expect(cross.value).toBeCloseTo(Math.round(exp.predicted.crossSpineGBps * 0.9 * 100) / 100, 6);
    expect(cross.source).toContain('tool-predicted busbw × 0.9');
    expect(get(kit, '40-node/node_diag.sh')).toContain('dcgmi diag -r 3');
  });

  it('AMD accelerators switch to rccl-tests, AGFHC and the AMD guide values', () => {
    const amdRack = ['amd-helios-mi455x'].find((id) => findCatalogItem(id));
    if (!amdRack) return;
    const p = { ...fx.project, equipment: fx.project.equipment.map((e) => (findCatalogItem(e.catalogId)?.category === 'gpu-rack' ? { ...e, catalogId: amdRack } : e)) };
    const m = buildTestKitModel(p, fx.analysis, fx.plan, fx.rows);
    expect(m.vendor).toBe('amd');
    expect(m.tool).toBe('rccl-tests');
    expect(m.thresholds.find((t) => t.id === 'node.agfhc')?.sourceType).toBe('acceptance-threshold');
    expect(m.thresholds.find((t) => t.id === 'collectives.cross-spine')).toBeUndefined();
  });

  it('README is well-formed in both locales', () => {
    expect(tagBalance(get(kit, 'README.html'))).toBe('');
    expect(tagBalance(get(kitKo, 'README.html'))).toBe('');
    expect(get(kitKo, 'README.html')).toContain('인수 기준');
    expect(get(kit, 'README.html')).toContain('Acceptance thresholds');
  });

  it('runs on the reference project with the live network generators (smoke)', () => {
    const { project } = createNvidiaReferenceProject();
    const files = generateTestPlan(project, fx.analysis);
    expect(files.length).toBeGreaterThan(20);
  });
});
