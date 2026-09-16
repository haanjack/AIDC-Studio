import { interpCurve } from '../../core/src/index.ts';
import { CP_AIR, FLAG_OPEN, RHO_AIR, type FaceSet, type ThermalCase } from './case.ts';
import { MGPCG, type MGOptions } from './multigrid.ts';
import type { CoolerThermal, RackThermal, ThermalMetrics, ThermalResult } from './types.ts';

/** RDHx door water inlet (vendor rating point, e.g. ChilledDoor 30 °C) and coil approach (estimate). */
const RDHX_WATER_IN_C = 30;
const RDHX_APPROACH_C = 1;
/** relative air-side energy balance |air heat − removed| ÷ air heat required for convergence */
const BALANCE_TOL = 0.02;
const GRAVITY = 9.81;
const RHO_CP = RHO_AIR * CP_AIR;
/** effective turbulent thermal diffusivity (m²/s) on top of the upwind numerical diffusion */
const KAPPA_T = 0.01;
const MAX_SPEED = 15;
const RCI_REC_MAX = 27;
const RCI_ALLOW_MAX = 32;
const RCI_REC_MIN = 18;
const RCI_ALLOW_MIN = 15;
/** EMA weight of the time-averaged fields (≈30-step memory) */
const AVG_ALPHA = 1 / 30;
/** steps between probe samples compared for the drift residual */
const HIST = 20;

/** Numerical knobs (defaults are tuned for 0.2–0.5 m data-hall grids). */
export interface SolverTuning {
  /** advective CFL number of the pseudo-time step (semi-Lagrangian, so > 1 is fine) */
  cfl: number;
  /** energy pseudo-time step as a multiple of the flow step */
  dtTFactor: number;
  /** Gauss–Seidel sweeps of the implicit energy equation per step (1 = alternate direction per step) */
  temperatureSweeps: number;
  /** pressure residual tolerance, multiplied by the cell size */
  pressureTol: number;
  /** PCG iteration cap per step (the solve is warm-started, so partial solves converge over steps) */
  pressureMaxIter: number;
  mg: Partial<MGOptions>;
}

export const DEFAULT_TUNING: SolverTuning = {
  cfl: 2.5,
  dtTFactor: 6,
  temperatureSweeps: 1,
  pressureTol: 1e-3,
  pressureMaxIter: 10,
  mg: { prolongation: 'constant', cycle: 'V', omega: 1.7, smooth: 2 },
};

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function sampleU(u: Float32Array, nx: number, ny: number, nz: number, x: number, y: number, z: number): number {
  let fx = x;
  let fy = y - 0.5;
  let fz = z - 0.5;
  if (fx < 0) fx = 0;
  else if (fx > nx) fx = nx;
  if (fy < 0) fy = 0;
  else if (fy > ny - 1) fy = ny - 1;
  if (fz < 0) fz = 0;
  else if (fz > nz - 1) fz = nz - 1;
  let i = fx | 0;
  if (i > nx - 1) i = nx - 1;
  let j = fy | 0;
  if (j > ny - 2) j = ny - 2;
  let k = fz | 0;
  if (k > nz - 2) k = nz - 2;
  const tx = fx - i;
  const ty = fy - j;
  const tz = fz - k;
  const sx = nx + 1;
  const a = i + sx * (j + ny * k);
  const b = a + sx;
  const c = a + sx * ny;
  const d = c + sx;
  const l0 = u[a] + tx * (u[a + 1] - u[a]);
  const l1 = u[b] + tx * (u[b + 1] - u[b]);
  const l2 = u[c] + tx * (u[c + 1] - u[c]);
  const l3 = u[d] + tx * (u[d + 1] - u[d]);
  const m0 = l0 + ty * (l1 - l0);
  const m1 = l2 + ty * (l3 - l2);
  return m0 + tz * (m1 - m0);
}

function sampleV(v: Float32Array, nx: number, ny: number, nz: number, x: number, y: number, z: number): number {
  let fx = x - 0.5;
  let fy = y;
  let fz = z - 0.5;
  if (fx < 0) fx = 0;
  else if (fx > nx - 1) fx = nx - 1;
  if (fy < 0) fy = 0;
  else if (fy > ny) fy = ny;
  if (fz < 0) fz = 0;
  else if (fz > nz - 1) fz = nz - 1;
  let i = fx | 0;
  if (i > nx - 2) i = nx - 2;
  let j = fy | 0;
  if (j > ny - 1) j = ny - 1;
  let k = fz | 0;
  if (k > nz - 2) k = nz - 2;
  const tx = fx - i;
  const ty = fy - j;
  const tz = fz - k;
  const sy = ny + 1;
  const a = i + nx * (j + sy * k);
  const b = a + nx;
  const c = a + nx * sy;
  const d = c + nx;
  const l0 = v[a] + tx * (v[a + 1] - v[a]);
  const l1 = v[b] + tx * (v[b + 1] - v[b]);
  const l2 = v[c] + tx * (v[c + 1] - v[c]);
  const l3 = v[d] + tx * (v[d + 1] - v[d]);
  const m0 = l0 + ty * (l1 - l0);
  const m1 = l2 + ty * (l3 - l2);
  return m0 + tz * (m1 - m0);
}

function sampleW(w: Float32Array, nx: number, ny: number, nz: number, x: number, y: number, z: number): number {
  let fx = x - 0.5;
  let fy = y - 0.5;
  let fz = z;
  if (fx < 0) fx = 0;
  else if (fx > nx - 1) fx = nx - 1;
  if (fy < 0) fy = 0;
  else if (fy > ny - 1) fy = ny - 1;
  if (fz < 0) fz = 0;
  else if (fz > nz) fz = nz;
  let i = fx | 0;
  if (i > nx - 2) i = nx - 2;
  let j = fy | 0;
  if (j > ny - 2) j = ny - 2;
  let k = fz | 0;
  if (k > nz - 1) k = nz - 1;
  const tx = fx - i;
  const ty = fy - j;
  const tz = fz - k;
  const nxny = nx * ny;
  const a = i + nx * (j + ny * k);
  const b = a + nx;
  const c = a + nxny;
  const d = c + nx;
  const l0 = w[a] + tx * (w[a + 1] - w[a]);
  const l1 = w[b] + tx * (w[b + 1] - w[b]);
  const l2 = w[c] + tx * (w[c + 1] - w[c]);
  const l3 = w[d] + tx * (w[d + 1] - w[d]);
  const m0 = l0 + ty * (l1 - l0);
  const m1 = l2 + ty * (l3 - l2);
  return m0 + tz * (m1 - m0);
}

/**
 * Pseudo-transient Boussinesq airflow + conservative implicit upwind energy transport on a MAC grid.
 * See packages/thermal/README.md for the method.
 */
export class ThermalSolver {
  readonly case: ThermalCase;
  readonly tuning: SolverTuning;
  private readonly nx: number;
  private readonly ny: number;
  private readonly nz: number;
  private readonly h: number;
  private readonly N: number;
  private u: Float32Array;
  private v: Float32Array;
  private w: Float32Array;
  private u0: Float32Array;
  private v0: Float32Array;
  private w0: Float32Array;
  private readonly bcU: Float32Array;
  private readonly bcV: Float32Array;
  private readonly bcW: Float32Array;
  private readonly T: Float32Array;
  private readonly Told: Float32Array;
  private readonly phi: Float64Array;
  private readonly rhs: Float64Array;
  private readonly sink: Float32Array;
  private readonly heat: Float32Array;
  private readonly mg: MGPCG;
  private readonly compSum: Float64Array;
  private readonly compCount: Float64Array;
  // device state
  private readonly rackQ: Float64Array;
  private readonly rackTin: Float64Array;
  private readonly rackTinMax: Float64Array;
  private readonly rackTex: Float64Array;
  /** T4: heat removed by each rack's rear door (kW) */
  private readonly rackDoor: Float64Array;
  /** T4: fluid cells inside hot-aisle containment zones (hot-aisle mean metric) */
  private readonly hotCells: Int32Array;
  private readonly coolQ: Float64Array;
  private readonly coolTret: Float64Array;
  private readonly coolTsup: Float64Array;
  private readonly Tavg: Float32Array;
  private readonly uA: Float32Array;
  private readonly vA: Float32Array;
  private readonly wA: Float32Array;
  private readonly avgTin: Float64Array;
  private readonly avgTinMax: Float64Array;
  private readonly avgTret: Float64Array;
  private readonly probeHist: Float64Array;
  private histPos = 0;
  private stepIndex = 0;
  private elapsed = 0;
  private dt = 0.2;
  private residual = Infinity;
  private streak = 0;
  private done = false;
  private hotspotCache: ThermalMetrics['hotspots'] = [];
  private hotspotStep = -1;
  readonly fluidCells: number;
  /** pressure solver iterations of the last step (diagnostics) */
  lastPressureIterations = 0;
  /** accumulated wall time per phase (ms, diagnostics) */
  readonly timings = { devices: 0, advect: 0, buoyancy: 0, project: 0, temperature: 0 };

  constructor(c: ThermalCase, tuning: Partial<SolverTuning> = {}) {
    this.case = c;
    this.tuning = { ...DEFAULT_TUNING, ...tuning, mg: { ...DEFAULT_TUNING.mg, ...(tuning.mg ?? {}) } };
    const { nx, ny, nz, cellSize } = c.grid;
    this.nx = nx;
    this.ny = ny;
    this.nz = nz;
    this.h = cellSize;
    const N = nx * ny * nz;
    this.N = N;
    const nu = (nx + 1) * ny * nz;
    const nv = nx * (ny + 1) * nz;
    const nw = nx * ny * (nz + 1);
    this.u = new Float32Array(nu);
    this.v = new Float32Array(nv);
    this.w = new Float32Array(nw);
    this.u0 = new Float32Array(nu);
    this.v0 = new Float32Array(nv);
    this.w0 = new Float32Array(nw);
    this.bcU = new Float32Array(nu);
    this.bcV = new Float32Array(nv);
    this.bcW = new Float32Array(nw);
    this.T = new Float32Array(N);
    this.Told = new Float32Array(N);
    this.phi = new Float64Array(N);
    this.rhs = new Float64Array(N);
    this.sink = new Float32Array(N);
    this.heat = new Float32Array(N);
    this.Tavg = new Float32Array(N);
    this.uA = new Float32Array(nu);
    this.vA = new Float32Array(nv);
    this.wA = new Float32Array(nw);
    this.compSum = new Float64Array(c.componentCount);
    this.compCount = new Float64Array(c.componentCount);
    let fluid = 0;
    for (let n = 0; n < N; n++) {
      if (!c.solid[n]) {
        fluid++;
        this.compCount[c.component[n]]++;
      }
    }
    this.fluidCells = fluid;
    this.mg = new MGPCG(nx, ny, nz, c.flagU, c.flagV, c.flagW, c.anchors, this.tuning.mg);
    const t0 = c.supplyC + 2;
    this.T.fill(t0);
    this.Tavg.fill(t0);
    this.rackQ = new Float64Array(c.racks.length);
    this.rackTin = new Float64Array(c.racks.length).fill(t0);
    this.rackTinMax = new Float64Array(c.racks.length).fill(t0);
    this.rackTex = new Float64Array(c.racks.length).fill(t0);
    this.rackDoor = new Float64Array(c.racks.length);
    const hot: number[] = [];
    const seenHot = new Uint8Array(N);
    for (const z of c.containments) {
      if (z.kind !== 'hot-aisle') continue;
      for (let k = z.k0; k <= z.k1; k++)
        for (let j = z.j0; j <= z.j1; j++)
          for (let i = z.i0; i <= z.i1; i++) {
            const cc = i + nx * (j + ny * k);
            if (c.solid[cc] || seenHot[cc]) continue;
            seenHot[cc] = 1;
            hot.push(cc);
          }
    }
    this.hotCells = Int32Array.from(hot);
    this.coolQ = new Float64Array(c.coolers.length);
    this.coolTret = new Float64Array(c.coolers.length).fill(t0);
    this.coolTsup = new Float64Array(c.coolers.length).fill(c.supplyC);
    this.avgTin = new Float64Array(c.racks.length).fill(t0);
    this.avgTinMax = new Float64Array(c.racks.length).fill(t0);
    this.avgTret = new Float64Array(c.coolers.length).fill(t0);
    this.probeHist = new Float64Array((HIST + 1) * (c.racks.length + c.coolers.length));
    // static heat: CDU fallback sources and racks whose faces are blocked
    for (const hs of c.heatSources) {
      const per = hs.watts / hs.cells.length;
      for (let n = 0; n < hs.cells.length; n++) this.heat[hs.cells[n]] += per;
    }
    for (const r of c.racks) {
      if (r.fallbackCells.length && r.airKW > 0) {
        const per = (r.airKW * 1000) / r.fallbackCells.length;
        for (let n = 0; n < r.fallbackCells.length; n++) this.heat[r.fallbackCells[n]] += per;
      }
    }
    this.updateDevices(true);
  }

  get steps(): number {
    return this.stepIndex;
  }

  get isConverged(): boolean {
    return this.done;
  }

  // ─────────────────────────── devices ───────────────────────────

  private setFaces(fs: FaceSet, velocity: number, temperature: number) {
    const vel = fs.axis === 0 ? this.u : fs.axis === 1 ? this.v : this.w;
    const bc = fs.axis === 0 ? this.bcU : fs.axis === 1 ? this.bcV : this.bcW;
    const faces = fs.faces;
    for (let n = 0; n < faces.length; n++) {
      vel[faces[n]] = velocity;
      bc[faces[n]] = temperature;
    }
  }

  private updateDevices(first: boolean): number {
    const c = this.case;
    const T = this.T;
    const A = this.h * this.h;
    let demand = 0;
    let maxSpeed = 0;
    for (let r = 0; r < c.racks.length; r++) {
      const rk = c.racks[r];
      const cells = rk.inlet.cells;
      let tIn = this.rackTin[r];
      let tMax = tIn;
      if (cells.length) {
        let s = 0;
        tMax = -Infinity;
        for (let n = 0; n < cells.length; n++) {
          const t = T[cells[n]];
          s += t;
          if (t > tMax) tMax = t;
        }
        tIn = s / cells.length;
      }
      const hasFaces = rk.inlet.faces.length > 0 && rk.exhaust.faces.length > 0;
      let q = 0;
      if (hasFaces && (rk.airKW > 0 || rk.nominalAirflowM3s > 0)) {
        const base = rk.airflowCurve ? interpCurve(rk.airflowCurve, tIn, rk.nominalAirflowM3s) : rk.nominalAirflowM3s;
        const target = base * rk.flowScale + (rk.extraAirflowM3s ?? 0);
        q = first ? target : this.rackQ[r] + 0.2 * (target - this.rackQ[r]);
      }
      this.rackQ[r] = q;
      // T4 RDHx: the door takes heat out of the exhaust stream before it reaches the aisle
      let door = 0;
      if (rk.doorKW !== undefined || rk.doorFraction !== undefined) {
        door = rk.airKW;
        if (rk.doorKW !== undefined) door = Math.min(door, rk.doorKW);
        if (rk.doorFraction !== undefined) door = Math.min(door, rk.airKW * rk.doorFraction);
        // fix v2 2차 (QA): the door coil cannot cool the exhaust below its water temperature — Q_door ≤ ṁ·cp·(T_exh,no door − (T_w,in +
        // approach)), T_w,in = 30 °C (the vendor rating point), approach 1 °C (estimate). Was: exhaust 24 °C against 30 °C water.
        if (q > 1e-6) {
          const tExNoDoor = tIn + Math.min(60, (rk.airKW * 1000) / (RHO_CP * q));
          door = Math.min(door, Math.max(0, (RHO_CP * q * (tExNoDoor - (RDHX_WATER_IN_C + RDHX_APPROACH_C))) / 1000));
        }
        door = q > 1e-6 ? Math.max(0, door) : 0;
      }
      this.rackDoor[r] = door;
      const dT = q > 1e-6 ? Math.min(60, ((rk.airKW - door) * 1000) / (RHO_CP * q)) : 0;
      const tEx = tIn + dT;
      this.rackTin[r] = tIn;
      this.rackTinMax[r] = tMax;
      this.rackTex[r] = tEx;
      if (q > 0) {
        const sIn = q / (rk.inlet.faces.length * A);
        const sEx = q / (rk.exhaust.faces.length * A);
        this.setFaces(rk.inlet, -sIn * rk.inlet.sign, tIn);
        this.setFaces(rk.exhaust, sEx * rk.exhaust.sign, tEx);
        if (sIn > maxSpeed) maxSpeed = sIn;
        if (sEx > maxSpeed) maxSpeed = sEx;
        demand += q;
      } else if (hasFaces) {
        this.setFaces(rk.inlet, 0, tIn);
        this.setFaces(rk.exhaust, 0, tIn);
      }
    }
    const nC = c.coolers.length;
    let totalSupplyFaces = 0;
    for (const o of c.coolers) totalSupplyFaces += o.supply.faces.length;
    const ratio = c.options.coolerAirflowRatio ?? 1.1;
    // T4: with in-row coolers in the mix the demand is shared by rated airflow (room-only cases keep equal shares)
    let weighted = false;
    let capSum = 0;
    for (const o of c.coolers) {
      if (o.kind === 'in-row') weighted = true;
      if (!o.virtual) capSum += o.maxAirflowM3s;
    }
    for (let k = 0; k < nC; k++) {
      const co = c.coolers[k];
      const cap = co.maxAirflowM3s;
      let target = weighted && capSum > 0 ? (ratio * demand * cap) / capSum : (ratio * demand) / Math.max(1, nC);
      if (co.virtual) {
        target = totalSupplyFaces > 0 ? (ratio * demand * co.supply.faces.length) / totalSupplyFaces : 0;
      } else if (cap > 0) {
        target = Math.min(cap, Math.max(0.15 * cap, target));
      }
      const q = first ? target : this.coolQ[k] + 0.2 * (target - this.coolQ[k]);
      this.coolQ[k] = q;
      let tRet = this.coolTret[k];
      const retCells = co.sinkCells.length ? co.sinkCells : co.returnFaces?.cells;
      if (retCells && retCells.length) {
        let s = 0;
        for (let n = 0; n < retCells.length; n++) s += T[retCells[n]];
        tRet = s / retCells.length;
      }
      this.coolTret[k] = tRet;
      // an overloaded coil cannot hold the set-point: supply temperature rises
      let tSupTarget = c.supplyC;
      if (co.capacityKW > 0 && q > 1e-6) tSupTarget = Math.max(c.supplyC, tRet - (co.capacityKW * 1000) / (RHO_CP * q));
      const tSup = first ? tSupTarget : this.coolTsup[k] + 0.3 * (tSupTarget - this.coolTsup[k]);
      this.coolTsup[k] = tSup;
      if (co.supply.faces.length && q > 0) {
        const s = q / (co.supply.faces.length * A);
        this.setFaces(co.supply, s * co.supply.sign, tSup);
        if (s > maxSpeed) maxSpeed = s;
      }
      if (co.sinkCells.length) {
        const per = q / co.sinkCells.length;
        for (let n = 0; n < co.sinkCells.length; n++) this.sink[co.sinkCells[n]] = per;
      } else if (co.returnFaces && co.returnFaces.faces.length) {
        const s = q / (co.returnFaces.faces.length * A);
        this.setFaces(co.returnFaces, -s * co.returnFaces.sign, tRet);
      }
    }
    return maxSpeed;
  }

  // ─────────────────────────── flow ───────────────────────────

  private advect() {
    const nx = this.nx;
    const ny = this.ny;
    const nz = this.nz;
    const s = this.dt / this.h;
    const u = this.u;
    const v = this.v;
    const w = this.w;
    const un = this.u0;
    const vn = this.v0;
    const wn = this.w0;
    const fU = this.case.flagU;
    const fV = this.case.flagV;
    const fW = this.case.flagW;
    const sx = nx + 1;
    const sy = ny + 1;
    const nxny = nx * ny;

    // u faces at (i, j+½, k+½)
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        const rowU = sx * (j + ny * k);
        const vb = nx * (j + sy * k);
        const vt = vb + nx;
        const wb = nx * (j + ny * k);
        const wt = wb + nxny;
        for (let i = 0; i <= nx; i++) {
          const f = rowU + i;
          if (fU[f] !== FLAG_OPEN) {
            un[f] = u[f];
            continue;
          }
          const il = i > 0 ? i - 1 : 0;
          const ir = i < nx ? i : nx - 1;
          const vv = 0.25 * (v[vb + il] + v[vb + ir] + v[vt + il] + v[vt + ir]);
          const ww = 0.25 * (w[wb + il] + w[wb + ir] + w[wt + il] + w[wt + ir]);
          un[f] = sampleU(u, nx, ny, nz, i - s * u[f], j + 0.5 - s * vv, k + 0.5 - s * ww);
        }
      }
    }
    // v faces at (i+½, j, k+½)
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j <= ny; j++) {
        const rowV = nx * (j + sy * k);
        const jl = j > 0 ? j - 1 : 0;
        const jr = j < ny ? j : ny - 1;
        const ul = sx * (jl + ny * k);
        const ur = sx * (jr + ny * k);
        const wl = nx * (jl + ny * k);
        const wr = nx * (jr + ny * k);
        for (let i = 0; i < nx; i++) {
          const f = rowV + i;
          if (fV[f] !== FLAG_OPEN) {
            vn[f] = v[f];
            continue;
          }
          const uu = 0.25 * (u[ul + i] + u[ul + i + 1] + u[ur + i] + u[ur + i + 1]);
          const ww = 0.25 * (w[wl + i] + w[wr + i] + w[wl + i + nxny] + w[wr + i + nxny]);
          vn[f] = sampleV(v, nx, ny, nz, i + 0.5 - s * uu, j - s * v[f], k + 0.5 - s * ww);
        }
      }
    }
    // w faces at (i+½, j+½, k)
    for (let k = 0; k <= nz; k++) {
      const kl = k > 0 ? k - 1 : 0;
      const kr = k < nz ? k : nz - 1;
      for (let j = 0; j < ny; j++) {
        const rowW = nx * (j + ny * k);
        const ul = sx * (j + ny * kl);
        const ur = sx * (j + ny * kr);
        const vl = nx * (j + sy * kl);
        const vr = nx * (j + sy * kr);
        for (let i = 0; i < nx; i++) {
          const f = rowW + i;
          if (fW[f] !== FLAG_OPEN) {
            wn[f] = w[f];
            continue;
          }
          const uu = 0.25 * (u[ul + i] + u[ul + i + 1] + u[ur + i] + u[ur + i + 1]);
          const vv = 0.25 * (v[vl + i] + v[vl + i + nx] + v[vr + i] + v[vr + i + nx]);
          wn[f] = sampleW(w, nx, ny, nz, i + 0.5 - s * uu, j + 0.5 - s * vv, k - s * w[f]);
        }
      }
    }
    this.u = un;
    this.u0 = u;
    this.v = vn;
    this.v0 = v;
    this.w = wn;
    this.w0 = w;
  }

  private buoyancy() {
    const nx = this.nx;
    const ny = this.ny;
    const nz = this.nz;
    const nxny = nx * ny;
    const w = this.w;
    const T = this.T;
    const fW = this.case.flagW;
    const tRef = this.case.supplyC;
    const beta = 1 / (273.15 + tRef);
    const g = this.dt * GRAVITY * beta;
    for (let k = 1; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        const row = nx * (j + ny * k);
        for (let i = 0; i < nx; i++) {
          const f = row + i;
          if (fW[f] !== FLAG_OPEN) continue;
          let val = w[f] + g * (0.5 * (T[f] + T[f - nxny]) - tRef);
          if (val > MAX_SPEED) val = MAX_SPEED;
          else if (val < -MAX_SPEED) val = -MAX_SPEED;
          w[f] = val;
        }
      }
    }
  }

  private project() {
    const nx = this.nx;
    const ny = this.ny;
    const nz = this.nz;
    const h = this.h;
    const sx = nx + 1;
    const sy = ny + 1;
    const nxny = nx * ny;
    const u = this.u;
    const v = this.v;
    const w = this.w;
    const rhs = this.rhs;
    const sink = this.sink;
    const c = this.case;
    const solid = c.solid;
    const comp = c.component;
    const diag = this.mg.fineDiag;
    const compSum = this.compSum;
    compSum.fill(0);
    const invH2 = 1 / (h * h);
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        const rowC = nx * (j + ny * k);
        const rowU = sx * (j + ny * k);
        const rowV = nx * (j + sy * k);
        for (let i = 0; i < nx; i++) {
          const cc = rowC + i;
          if (solid[cc] || diag[cc] <= 0) {
            rhs[cc] = 0;
            continue;
          }
          const div = u[rowU + i + 1] - u[rowU + i] + v[rowV + i + nx] - v[rowV + i] + w[cc + nxny] - w[cc];
          // Σ_open (φ_c − φ_nb) = h (S/h² − D*), S = −sink (volume flow leaving the cell)
          const val = h * (-sink[cc] * invH2 - div);
          rhs[cc] = val;
          compSum[comp[cc]] += val;
        }
      }
    }
    const compCount = this.compCount;
    let needMean = false;
    for (let q = 0; q < compSum.length; q++) {
      if (compCount[q] > 0 && compSum[q] !== 0) {
        compSum[q] /= compCount[q];
        needMean = true;
      }
    }
    if (needMean) {
      for (let n = 0; n < this.N; n++) {
        if (solid[n] || diag[n] <= 0) continue;
        rhs[n] -= compSum[comp[n]];
      }
    }
    this.mg.solve(rhs, this.phi, h * this.tuning.pressureTol, this.tuning.pressureMaxIter);
    this.lastPressureIterations = this.mg.lastIterations;
    const phi = this.phi;
    const invH = 1 / h;
    const fU = c.flagU;
    const fV = c.flagV;
    const fW = c.flagW;
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        const rowC = nx * (j + ny * k);
        const rowU = sx * (j + ny * k);
        for (let i = 1; i < nx; i++) {
          const f = rowU + i;
          if (fU[f] === FLAG_OPEN) u[f] -= (phi[rowC + i] - phi[rowC + i - 1]) * invH;
        }
      }
    }
    for (let k = 0; k < nz; k++) {
      for (let j = 1; j < ny; j++) {
        const rowC = nx * (j + ny * k);
        const rowV = nx * (j + sy * k);
        for (let i = 0; i < nx; i++) {
          const f = rowV + i;
          if (fV[f] === FLAG_OPEN) v[f] -= (phi[rowC + i] - phi[rowC + i - nx]) * invH;
        }
      }
    }
    for (let k = 1; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        const row = nx * (j + ny * k);
        for (let i = 0; i < nx; i++) {
          const f = row + i;
          if (fW[f] === FLAG_OPEN) w[f] -= (phi[f] - phi[f - nxny]) * invH;
        }
      }
    }
  }

  // ─────────────────────────── energy ───────────────────────────

  /**
   * One Gauss–Seidel sweep of the implicit, conservative, first-order upwind energy equation
   *   V/Δt (T − T_old) + Σ_f F_f T_upwind − Σ_open κh (T_nb − T) + sink·T = q/(ρ c_p)
   * Fixed (device) faces bring in their boundary temperature; walls are adiabatic.
   */
  private temperatureSweep(forward: boolean, dtT: number) {
    const nx = this.nx;
    const ny = this.ny;
    const nz = this.nz;
    const h = this.h;
    const A = h * h;
    const V = A * h;
    const vdt = V / dtT;
    const kh = KAPPA_T * h;
    const sx = nx + 1;
    const sy = ny + 1;
    const nxny = nx * ny;
    const T = this.T;
    const Told = this.Told;
    const u = this.u;
    const v = this.v;
    const w = this.w;
    const bcU = this.bcU;
    const bcV = this.bcV;
    const bcW = this.bcW;
    const fU = this.case.flagU;
    const fV = this.case.flagV;
    const fW = this.case.flagW;
    const solid = this.case.solid;
    const sink = this.sink;
    const heat = this.heat;
    const invRhoCp = 1 / RHO_CP;
    const k0 = forward ? 0 : nz - 1;
    const kEnd = forward ? nz : -1;
    const dk = forward ? 1 : -1;
    const j0 = forward ? 0 : ny - 1;
    const jEnd = forward ? ny : -1;
    const i0 = forward ? 0 : nx - 1;
    const iEnd = forward ? nx : -1;
    for (let k = k0; k !== kEnd; k += dk) {
      for (let j = j0; j !== jEnd; j += dk) {
        const rowC = nx * (j + ny * k);
        const rowU = sx * (j + ny * k);
        const rowV = nx * (j + sy * k);
        for (let i = i0; i !== iEnd; i += dk) {
          const c = rowC + i;
          if (solid[c]) continue;
          let out = sink[c];
          let inflow = 0;
          let num = vdt * Told[c] + heat[c] * invRhoCp;
          let dif = 0;
          let fl: number;
          let F: number;
          // x−
          let f = rowU + i;
          fl = fU[f];
          if (fl !== 1) {
            F = -u[f] * A;
            if (fl === FLAG_OPEN) {
              const tn = T[c - 1];
              if (F > 0) out += F;
              else {
                inflow -= F;
                num -= F * tn;
              }
              dif += kh;
              num += kh * tn;
            } else if (F > 0) out += F;
            else {
              inflow -= F;
              num -= F * bcU[f];
            }
          }
          // x+
          f = rowU + i + 1;
          fl = fU[f];
          if (fl !== 1) {
            F = u[f] * A;
            if (fl === FLAG_OPEN) {
              const tn = T[c + 1];
              if (F > 0) out += F;
              else {
                inflow -= F;
                num -= F * tn;
              }
              dif += kh;
              num += kh * tn;
            } else if (F > 0) out += F;
            else {
              inflow -= F;
              num -= F * bcU[f];
            }
          }
          // y−
          f = rowV + i;
          fl = fV[f];
          if (fl !== 1) {
            F = -v[f] * A;
            if (fl === FLAG_OPEN) {
              const tn = T[c - nx];
              if (F > 0) out += F;
              else {
                inflow -= F;
                num -= F * tn;
              }
              dif += kh;
              num += kh * tn;
            } else if (F > 0) out += F;
            else {
              inflow -= F;
              num -= F * bcV[f];
            }
          }
          // y+
          f = rowV + i + nx;
          fl = fV[f];
          if (fl !== 1) {
            F = v[f] * A;
            if (fl === FLAG_OPEN) {
              const tn = T[c + nx];
              if (F > 0) out += F;
              else {
                inflow -= F;
                num -= F * tn;
              }
              dif += kh;
              num += kh * tn;
            } else if (F > 0) out += F;
            else {
              inflow -= F;
              num -= F * bcV[f];
            }
          }
          // z−
          f = c;
          fl = fW[f];
          if (fl !== 1) {
            F = -w[f] * A;
            if (fl === FLAG_OPEN) {
              const tn = T[c - nxny];
              if (F > 0) out += F;
              else {
                inflow -= F;
                num -= F * tn;
              }
              dif += kh;
              num += kh * tn;
            } else if (F > 0) out += F;
            else {
              inflow -= F;
              num -= F * bcW[f];
            }
          }
          // z+
          f = c + nxny;
          fl = fW[f];
          if (fl !== 1) {
            F = w[f] * A;
            if (fl === FLAG_OPEN) {
              const tn = T[c + nxny];
              if (F > 0) out += F;
              else {
                inflow -= F;
                num -= F * tn;
              }
              dif += kh;
              num += kh * tn;
            } else if (F > 0) out += F;
            else {
              inflow -= F;
              num -= F * bcW[f];
            }
          }
          // with an exactly divergence-free flux out + sink == inflow; the max() keeps the update
          // bounded while the pressure solve is still converging
          T[c] = num / (vdt + (out > inflow ? out : inflow) + dif);
        }
      }
    }
  }

  // ─────────────────────────── driver ───────────────────────────

  step(n = 1): ThermalMetrics {
    const c = this.case;
    const tol = c.options.tolerance ?? 0.01;
    const tune = this.tuning;
    for (let s = 0; s < n; s++) {
      const t0 = now();
      const tm = this.timings;
      const maxSpeed = this.updateDevices(false);
      this.dt = Math.min(1.0, Math.max(0.05, (tune.cfl * this.h) / Math.max(0.5, maxSpeed)));
      const t1 = now();
      this.advect();
      const t2 = now();
      this.buoyancy();
      const t3 = now();
      this.project();
      const t4 = now();
      this.Told.set(this.T);
      const dtT = this.dt * tune.dtTFactor;
      if (tune.temperatureSweeps <= 1) {
        this.temperatureSweep(this.stepIndex % 2 === 0, dtT);
      } else {
        for (let q = 0; q < tune.temperatureSweeps; q++) this.temperatureSweep(q % 2 === 0, dtT);
      }
      const t5 = now();
      tm.devices += t1 - t0;
      tm.advect += t2 - t1;
      tm.buoyancy += t3 - t2;
      tm.project += t4 - t3;
      tm.temperature += t5 - t4;
      this.stepIndex++;
      // residual: drift of the time-averaged rack inlet / cooler return temperatures (°C per step)
      const res = this.updateAverages();
      this.residual = res;
      this.streak = res < tol ? this.streak + 1 : 0;
      if (this.stepIndex >= 80 && this.streak >= 10) {
        // fix v2 2차 (QA): the drift residual alone accepted a −50 % air-side energy balance — also require |balance| < 2 %
        // (or the drift has been steady for 25× the streak window, so a case that cannot close still terminates)
        const m = this.metrics();
        if (Math.abs(m.balanceError) < BALANCE_TOL || this.streak >= 250) this.done = true;
      }
      this.elapsed += now() - t0;
    }
    return this.metrics();
  }

  /**
   * Update the exponentially time-averaged fields (the pseudo-transient flow keeps small unsteady
   * fluctuations, so reported fields/metrics are averages) and return the windowed drift residual.
   */
  private updateAverages(): number {
    const c = this.case;
    const n = this.stepIndex;
    const a = Math.max(1 / n, AVG_ALPHA);
    const T = this.T;
    const Ta = this.Tavg;
    for (let i = 0; i < this.N; i++) Ta[i] += a * (T[i] - Ta[i]);
    const pairs: [Float32Array, Float32Array][] = [
      [this.u, this.uA],
      [this.v, this.vA],
      [this.w, this.wA],
    ];
    for (const [src, dst] of pairs) for (let i = 0; i < src.length; i++) dst[i] += a * (src[i] - dst[i]);
    const P = c.racks.length + c.coolers.length;
    const row = this.histPos * P;
    const hist = this.probeHist;
    for (let r = 0; r < c.racks.length; r++) {
      const cells = c.racks[r].inlet.cells;
      if (!cells.length) continue;
      let s = 0;
      let mx = -Infinity;
      for (let q = 0; q < cells.length; q++) {
        const t = Ta[cells[q]];
        s += t;
        if (t > mx) mx = t;
      }
      this.avgTin[r] = s / cells.length;
      this.avgTinMax[r] = mx;
      hist[row + r] = this.avgTin[r];
    }
    for (let k = 0; k < c.coolers.length; k++) {
      const co = c.coolers[k];
      const cells = co.sinkCells.length ? co.sinkCells : co.returnFaces?.cells;
      if (cells && cells.length) {
        let s = 0;
        for (let q = 0; q < cells.length; q++) s += Ta[cells[q]];
        this.avgTret[k] = s / cells.length;
      }
      hist[row + c.racks.length + k] = this.avgTret[k];
    }
    let res = Infinity;
    if (n > HIST) {
      res = 0;
      const old = ((this.histPos + 1) % (HIST + 1)) * P;
      for (let p = 0; p < P; p++) {
        const d = Math.abs(hist[row + p] - hist[old + p]) / HIST;
        if (d > res) res = d;
      }
    }
    this.histPos = (this.histPos + 1) % (HIST + 1);
    return res;
  }

  metrics(includeHotspots = false): ThermalMetrics {
    const c = this.case;
    const racks: RackThermal[] = [];
    let airHeat = 0;
    let doorRemoved = 0;
    let maxInlet = -Infinity;
    let sumInlet = 0;
    let nInlet = 0;
    let overHi = 0;
    let underLo = 0;
    let shiNum = 0;
    let shiDen = 0;
    let dtFlowSum = 0;
    let flowSum = 0;
    for (let r = 0; r < c.racks.length; r++) {
      const rk = c.racks[r];
      const q = this.rackQ[r];
      const dT = this.rackTex[r] - this.rackTin[r];
      if (rk.aux) {
        // auxiliary in-row units (CDU cabinets) add heat but are not IT intakes
        airHeat += q > 0 ? (RHO_CP * q * dT) / 1000 : 0;
        continue;
      }
      const recirc = rk.recirculation * dT;
      const inletAvg = this.avgTin[r] + recirc;
      const inletMax = this.avgTinMax[r] + recirc;
      racks.push({
        id: rk.id,
        tag: rk.tag,
        inletAvgC: inletAvg,
        inletMaxC: inletMax,
        exhaustC: this.avgTin[r] + dT,
        airKW: rk.airKW,
        airflowM3s: q,
        ...(this.rackDoor[r] > 0 ? { doorKW: this.rackDoor[r] } : {}),
      });
      doorRemoved += this.rackDoor[r];
      // heat actually injected by the exhaust (can be < airKW only if the ΔT cap triggers)
      airHeat += q > 0 ? (RHO_CP * q * dT) / 1000 : rk.fallbackCells.length ? rk.airKW : 0;
      if (q > 0) {
        if (inletMax > maxInlet) maxInlet = inletMax;
        sumInlet += inletAvg;
        nInlet++;
        if (inletMax > RCI_REC_MAX) overHi += inletMax - RCI_REC_MAX;
        if (inletMax < RCI_REC_MIN) underLo += RCI_REC_MIN - inletMax;
        shiNum += q * (this.avgTin[r] - c.supplyC);
        shiDen += q * (this.avgTin[r] + dT - c.supplyC);
        dtFlowSum += q * dT;
        flowSum += q;
      }
    }
    for (const hs of c.heatSources) airHeat += hs.watts / 1000;
    const coolers: CoolerThermal[] = [];
    let removed = 0;
    let qRet = 0;
    let tRetSum = 0;
    let tSupSum = 0;
    for (let k = 0; k < c.coolers.length; k++) {
      const co = c.coolers[k];
      const q = this.coolQ[k];
      const load = (RHO_CP * q * (this.avgTret[k] - this.coolTsup[k])) / 1000;
      removed += load;
      qRet += q;
      tRetSum += q * this.avgTret[k];
      tSupSum += q * this.coolTsup[k];
      coolers.push({
        id: co.id,
        tag: co.tag,
        returnC: this.avgTret[k],
        supplyC: this.coolTsup[k],
        loadKW: load,
        capacityKW: co.capacityKW,
        airflowM3s: q,
        kind: co.kind ?? 'room',
      });
    }
    let hotSum = 0;
    for (let n = 0; n < this.hotCells.length; n++) hotSum += this.Tavg[this.hotCells[n]];
    const rciHi = nInlet > 0 ? 100 * (1 - overHi / (nInlet * (RCI_ALLOW_MAX - RCI_REC_MAX))) : 100;
    const rciLo = nInlet > 0 ? 100 * (1 - underLo / (nInlet * (RCI_REC_MIN - RCI_ALLOW_MIN))) : 100;
    const dTe = flowSum > 0 ? dtFlowSum / flowSum : 0;
    const rti = qRet > 0 && dTe > 0 ? (100 * (tRetSum / qRet - tSupSum / qRet)) / dTe : 0;
    if (includeHotspots || this.hotspotStep < 0 || this.stepIndex - this.hotspotStep >= 20) {
      this.hotspotCache = this.findHotspots();
      this.hotspotStep = this.stepIndex;
    }
    return {
      step: this.stepIndex,
      residual: this.residual,
      converged: this.done,
      elapsedMs: this.elapsed,
      racks,
      coolers,
      maxInletC: nInlet ? maxInlet : c.supplyC,
      avgInletC: nInlet ? sumInlet / nInlet : c.supplyC,
      rciHi,
      rciLo,
      rti,
      shi: shiDen > 0 ? shiNum / shiDen : 0,
      airHeatKW: airHeat,
      removedKW: removed,
      balanceError: airHeat > 0 ? (airHeat - removed) / airHeat : 0,
      hotspots: this.hotspotCache,
      doorRemovedKW: doorRemoved,
      ...(this.hotCells.length ? { hotAisleAvgC: hotSum / this.hotCells.length } : {}),
    };
  }

  /** Hottest cells in the occupied zone outside contained hot aisles, at least 1 m apart. */
  private findHotspots(): ThermalMetrics['hotspots'] {
    const c = this.case;
    const { nx, ny, nz, cellSize: h, origin } = c.grid;
    const kMax = c.ceilingK > 0 ? c.ceilingK : nz;
    const T = this.Tavg;
    const exclude = new Uint8Array(nx * ny * nz);
    if (c.options.overrides?.containment !== 'none') {
      for (const z of c.containments) {
        if (z.kind !== 'hot-aisle') continue;
        for (let k = 0; k <= z.chimneyTopK; k++)
          for (let j = z.j0; j <= z.j1; j++) for (let i = z.i0; i <= z.i1; i++) exclude[i + nx * (j + ny * k)] = 1;
      }
    }
    const K = 64;
    const topT = new Float64Array(K).fill(-Infinity);
    const topC = new Int32Array(K).fill(-1);
    const threshold = c.supplyC + 1;
    for (let k = 0; k < kMax; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const cc = i + nx * (j + ny * k);
          if (c.solid[cc] || exclude[cc]) continue;
          const t = T[cc];
          if (t <= threshold || t <= topT[K - 1]) continue;
          let p = K - 1;
          while (p > 0 && topT[p - 1] < t) {
            topT[p] = topT[p - 1];
            topC[p] = topC[p - 1];
            p--;
          }
          topT[p] = t;
          topC[p] = cc;
        }
    const out: ThermalMetrics['hotspots'] = [];
    for (let n = 0; n < K && out.length < 10; n++) {
      const cc = topC[n];
      if (cc < 0) break;
      const i = cc % nx;
      const j = ((cc / nx) | 0) % ny;
      const k = (cc / (nx * ny)) | 0;
      const x = origin.x + (i + 0.5) * h;
      const y = origin.y + (j + 0.5) * h;
      const z = origin.z + (k + 0.5) * h;
      if (out.some((o) => (o.x - x) ** 2 + (o.y - y) ** 2 + (o.z - z) ** 2 < 1)) continue;
      out.push({ x, y, z, tempC: topT[n] });
    }
    return out;
  }

  snapshot(): ThermalResult {
    const c = this.case;
    const { nx, ny, nz } = c.grid;
    const N = this.N;
    const velocity = new Float32Array(N * 3);
    const sx = nx + 1;
    const sy = ny + 1;
    const nxny = nx * ny;
    const u = this.uA;
    const v = this.vA;
    const w = this.wA;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++) {
        const rowC = nx * (j + ny * k);
        const rowU = sx * (j + ny * k);
        const rowV = nx * (j + sy * k);
        for (let i = 0; i < nx; i++) {
          const cc = rowC + i;
          if (c.solid[cc]) continue;
          const o = cc * 3;
          velocity[o] = 0.5 * (u[rowU + i] + u[rowU + i + 1]);
          velocity[o + 1] = 0.5 * (v[rowV + i] + v[rowV + i + nx]);
          velocity[o + 2] = 0.5 * (w[cc] + w[cc + nxny]);
        }
      }
    const temperature = new Float32Array(this.Tavg);
    // solid cells keep a finite value (supply temperature) so the field can be uploaded as a texture
    for (let n = 0; n < N; n++) if (c.solid[n]) temperature[n] = c.supplyC;
    return {
      grid: { ...c.grid, origin: { ...c.grid.origin } },
      temperature,
      velocity,
      solid: new Uint8Array(c.solid),
      metrics: this.metrics(true),
      options: c.options,
    };
  }
}
