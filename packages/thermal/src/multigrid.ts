/**
 * Multigrid-preconditioned conjugate gradient (MGPCG) for the pressure Poisson equation
 *   Σ_open w_f (φ_c − φ_nb) = b_c
 * on a cell-centered grid with per-face conductances w (0 = wall / solid / fixed face).
 *
 * Two hierarchies are available:
 *  - 'trilinear' (default): cell-centered trilinear prolongation (27/64, 9/64, 3/64, 1/64 stencil,
 *    renormalized over fluid coarse cells), restriction = Pᵀ, rediscretized 7-point coarse operators
 *    with open-area fractions (w_c = ½ Σ child faces).
 *  - 'constant': piecewise-constant prolongation with Galerkin (aggregation) coarse operators.
 * Smoothing is red–black Gauss–Seidel arranged symmetrically so the cycle is a valid CG preconditioner.
 * One anchor cell per connected air volume removes the Neumann null space.
 */

export interface MGOptions {
  prolongation: 'trilinear' | 'constant';
  cycle: 'V' | 'W';
  /** coarse-grid correction scaling */
  omega: number;
  /** red+black sweeps before and after the coarse correction */
  smooth: number;
}

interface Level {
  nx: number;
  ny: number;
  nz: number;
  n: number;
  wx: Float32Array;
  wy: Float32Array;
  wz: Float32Array;
  diag: Float32Array;
  x: Float64Array;
  b: Float64Array;
  r: Float64Array;
  tmp: Float64Array | null;
  /** 1 / Σ trilinear weights over fluid coarse cells (for this level's cells, towards level+1) */
  invW: Float32Array | null;
}

function makeLevel(nx: number, ny: number, nz: number, w: boolean): Level {
  const n = nx * ny * nz;
  return {
    nx,
    ny,
    nz,
    n,
    wx: new Float32Array((nx + 1) * ny * nz),
    wy: new Float32Array(nx * (ny + 1) * nz),
    wz: new Float32Array(nx * ny * (nz + 1)),
    diag: new Float32Array(n),
    x: new Float64Array(n),
    b: new Float64Array(n),
    r: new Float64Array(n),
    tmp: w ? new Float64Array(n) : null,
    invW: null,
  };
}

function faceDiag(L: Level) {
  const { nx, ny, nz, wx, wy, wz, diag } = L;
  const sx = nx + 1;
  const nxny = nx * ny;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++) {
      const rowC = nx * (j + ny * k);
      const rowU = sx * (j + ny * k);
      const rowV = nx * (j + (ny + 1) * k);
      for (let i = 0; i < nx; i++) {
        const c = rowC + i;
        diag[c] = wx[rowU + i] + wx[rowU + i + 1] + wy[rowV + i] + wy[rowV + i + nx] + wz[c] + wz[c + nxny];
      }
    }
}

/** Sum child face conductances onto the coarse faces, multiplied by `scale`. */
function coarsenFaces(F: Level, C: Level, scale: number) {
  const fsx = F.nx + 1;
  const csx = C.nx + 1;
  const { nx: cnx, ny: cny, nz: cnz } = C;
  for (let ck = 0; ck < cnz; ck++)
    for (let cj = 0; cj < cny; cj++)
      for (let ci = 1; ci < cnx; ci++) {
        const i = 2 * ci;
        if (i > F.nx) continue;
        let s = 0;
        for (let dk = 0; dk < 2; dk++) {
          const k = 2 * ck + dk;
          if (k >= F.nz) continue;
          for (let dj = 0; dj < 2; dj++) {
            const j = 2 * cj + dj;
            if (j < F.ny) s += F.wx[i + fsx * (j + F.ny * k)];
          }
        }
        C.wx[ci + csx * (cj + cny * ck)] = s * scale;
      }
  for (let ck = 0; ck < cnz; ck++)
    for (let cj = 1; cj < cny; cj++)
      for (let ci = 0; ci < cnx; ci++) {
        const j = 2 * cj;
        if (j > F.ny) continue;
        let s = 0;
        for (let dk = 0; dk < 2; dk++) {
          const k = 2 * ck + dk;
          if (k >= F.nz) continue;
          for (let di = 0; di < 2; di++) {
            const i = 2 * ci + di;
            if (i < F.nx) s += F.wy[i + F.nx * (j + (F.ny + 1) * k)];
          }
        }
        C.wy[ci + cnx * (cj + (cny + 1) * ck)] = s * scale;
      }
  for (let ck = 1; ck < cnz; ck++)
    for (let cj = 0; cj < cny; cj++)
      for (let ci = 0; ci < cnx; ci++) {
        const k = 2 * ck;
        if (k > F.nz) continue;
        let s = 0;
        for (let dj = 0; dj < 2; dj++) {
          const j = 2 * cj + dj;
          if (j >= F.ny) continue;
          for (let di = 0; di < 2; di++) {
            const i = 2 * ci + di;
            if (i < F.nx) s += F.wz[i + F.nx * (j + F.ny * k)];
          }
        }
        C.wz[ci + cnx * (cj + cny * ck)] = s * scale;
      }
}

function coarsenGalerkin(F: Level, withTmp: boolean): Level {
  const C = makeLevel((F.nx + 1) >> 1, (F.ny + 1) >> 1, (F.nz + 1) >> 1, withTmp);
  coarsenFaces(F, C, 1);
  const { nx, ny, nz } = F;
  const fsx = nx + 1;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = i + nx * (j + ny * k);
        let d = F.diag[c];
        if (i & 1) d -= 2 * F.wx[i + fsx * (j + ny * k)];
        if (j & 1) d -= 2 * F.wy[i + nx * (j + (ny + 1) * k)];
        if (k & 1) d -= 2 * F.wz[c];
        C.diag[(i >> 1) + C.nx * ((j >> 1) + C.ny * (k >> 1))] += d;
      }
  for (let n = 0; n < C.n; n++) if (C.diag[n] < 1e-6) C.diag[n] = 0;
  return C;
}

function coarsenRediscretized(F: Level, fineAnchors: Int32Array, withTmp: boolean): { C: Level; anchors: Int32Array } {
  const C = makeLevel((F.nx + 1) >> 1, (F.ny + 1) >> 1, (F.nz + 1) >> 1, withTmp);
  coarsenFaces(F, C, 0.5);
  faceDiag(C);
  const set = new Set<number>();
  for (let a = 0; a < fineAnchors.length; a++) {
    const f = fineAnchors[a];
    const i = f % F.nx;
    const j = ((f / F.nx) | 0) % F.ny;
    const k = (f / (F.nx * F.ny)) | 0;
    set.add((i >> 1) + C.nx * ((j >> 1) + C.ny * (k >> 1)));
  }
  const anchors = Int32Array.from(set);
  for (let a = 0; a < anchors.length; a++) C.diag[anchors[a]] += 1;
  return { C, anchors };
}

/** Precompute trilinear normalization of every fluid fine cell over fluid coarse neighbors. */
function trilinearNorm(F: Level, C: Level): Float32Array {
  const inv = new Float32Array(F.n);
  const { nx, ny, nz } = F;
  const cnx = C.nx;
  const cny = C.ny;
  const cnz = C.nz;
  for (let k = 0; k < nz; k++) {
    const K = k >> 1;
    const K2 = k & 1 ? K + 1 : K - 1;
    const kOk = K2 >= 0 && K2 < cnz;
    for (let j = 0; j < ny; j++) {
      const J = j >> 1;
      const J2 = j & 1 ? J + 1 : J - 1;
      const jOk = J2 >= 0 && J2 < cny;
      for (let i = 0; i < nx; i++) {
        const c = i + nx * (j + ny * k);
        if (F.diag[c] <= 0) continue;
        const I = i >> 1;
        const I2 = i & 1 ? I + 1 : I - 1;
        const iOk = I2 >= 0 && I2 < cnx;
        let s = 0;
        for (let a = 0; a < 2; a++) {
          if (a === 1 && !iOk) continue;
          const ci = a ? I2 : I;
          const wa = a ? 0.25 : 0.75;
          for (let b = 0; b < 2; b++) {
            if (b === 1 && !jOk) continue;
            const cj = b ? J2 : J;
            const wb = b ? 0.25 : 0.75;
            for (let d = 0; d < 2; d++) {
              if (d === 1 && !kOk) continue;
              const ck = d ? K2 : K;
              if (C.diag[ci + cnx * (cj + cny * ck)] > 0) s += wa * wb * (d ? 0.25 : 0.75);
            }
          }
        }
        inv[c] = s > 0 ? 1 / s : 0;
      }
    }
  }
  return inv;
}

/** In-place red–black Gauss–Seidel sweep of one color. */
function smooth(L: Level, color: number) {
  const { nx, ny, nz, wx, wy, wz, diag, x, b } = L;
  const sx = nx + 1;
  const nxny = nx * ny;
  const n = L.n;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++) {
      const rowC = nx * (j + ny * k);
      const rowU = sx * (j + ny * k);
      const rowV = nx * (j + (ny + 1) * k);
      for (let i = (j + k + color) & 1; i < nx; i += 2) {
        const c = rowC + i;
        const d = diag[c];
        if (d <= 0) continue;
        let s = b[c];
        let w = wx[rowU + i];
        if (w !== 0) s += w * x[c - 1];
        w = wx[rowU + i + 1];
        if (w !== 0) s += w * x[c + 1];
        w = wy[rowV + i];
        if (w !== 0) s += w * x[c - nx];
        w = wy[rowV + i + nx];
        if (w !== 0) s += w * x[c + nx];
        w = wz[c];
        if (w !== 0) s += w * x[c - nxny];
        w = wz[c + nxny];
        if (w !== 0 && c + nxny < n) s += w * x[c + nxny];
        x[c] = s / d;
      }
    }
}

/** out = A·x */
function applyA(L: Level, xs: Float64Array, out: Float64Array) {
  const { nx, ny, nz, wx, wy, wz, diag } = L;
  const sx = nx + 1;
  const nxny = nx * ny;
  const n = L.n;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++) {
      const rowC = nx * (j + ny * k);
      const rowU = sx * (j + ny * k);
      const rowV = nx * (j + (ny + 1) * k);
      for (let i = 0; i < nx; i++) {
        const c = rowC + i;
        const d = diag[c];
        if (d <= 0) {
          out[c] = 0;
          continue;
        }
        let s = d * xs[c];
        let w = wx[rowU + i];
        if (w !== 0) s -= w * xs[c - 1];
        w = wx[rowU + i + 1];
        if (w !== 0) s -= w * xs[c + 1];
        w = wy[rowV + i];
        if (w !== 0) s -= w * xs[c - nx];
        w = wy[rowV + i + nx];
        if (w !== 0) s -= w * xs[c + nx];
        w = wz[c];
        if (w !== 0) s -= w * xs[c - nxny];
        w = wz[c + nxny];
        if (w !== 0 && c + nxny < n) s -= w * xs[c + nxny];
        out[c] = s;
      }
    }
}

export const DEFAULT_MG_OPTIONS: MGOptions = { prolongation: 'trilinear', cycle: 'V', omega: 1, smooth: 1 };

export class MGPCG {
  readonly levels: Level[] = [];
  readonly opts: MGOptions;
  private readonly r: Float64Array;
  private readonly z: Float64Array;
  private readonly p: Float64Array;
  private readonly Ap: Float64Array;
  bottomSweeps = 24;
  lastIterations = 0;
  lastResidual = 0;

  constructor(nx: number, ny: number, nz: number, flagU: Uint8Array, flagV: Uint8Array, flagW: Uint8Array, anchors: Int32Array, opts: Partial<MGOptions> = {}) {
    this.opts = { ...DEFAULT_MG_OPTIONS, ...opts };
    const withTmp = this.opts.cycle === 'W';
    const L0 = makeLevel(nx, ny, nz, withTmp);
    for (let n = 0; n < flagU.length; n++) L0.wx[n] = flagU[n] === 0 ? 1 : 0;
    for (let n = 0; n < flagV.length; n++) L0.wy[n] = flagV[n] === 0 ? 1 : 0;
    for (let n = 0; n < flagW.length; n++) L0.wz[n] = flagW[n] === 0 ? 1 : 0;
    faceDiag(L0);
    for (let a = 0; a < anchors.length; a++) L0.diag[anchors[a]] += 1;
    this.levels.push(L0);
    let L = L0;
    let levelAnchors = anchors;
    while (Math.min(L.nx, L.ny, L.nz) > 3 && L.n > 512) {
      let C: Level;
      if (this.opts.prolongation === 'constant') {
        C = coarsenGalerkin(L, withTmp);
      } else {
        const res = coarsenRediscretized(L, levelAnchors, withTmp);
        C = res.C;
        levelAnchors = res.anchors;
        L.invW = trilinearNorm(L, C);
      }
      this.levels.push(C);
      L = C;
    }
    const n = L0.n;
    this.r = new Float64Array(n);
    this.z = new Float64Array(n);
    this.p = new Float64Array(n);
    this.Ap = new Float64Array(n);
  }

  get fineDiag(): Float32Array {
    return this.levels[0].diag;
  }

  private restrict(F: Level, C: Level) {
    const rr = F.r;
    const cb = C.b;
    cb.fill(0);
    const { nx, ny, nz } = F;
    const cnx = C.nx;
    const cny = C.ny;
    const cnz = C.nz;
    if (this.opts.prolongation === 'constant') {
      for (let k = 0; k < nz; k++) {
        const pk = cny * (k >> 1);
        for (let j = 0; j < ny; j++) {
          const pj = cnx * ((j >> 1) + pk);
          const row = nx * (j + ny * k);
          for (let i = 0; i < nx; i++) cb[(i >> 1) + pj] += rr[row + i];
        }
      }
      return;
    }
    const inv = F.invW as Float32Array;
    const cd = C.diag;
    for (let k = 0; k < nz; k++) {
      const K = k >> 1;
      let K2 = k & 1 ? K + 1 : K - 1;
      let wk1 = 0.25;
      if (K2 < 0 || K2 >= cnz) {
        K2 = K;
        wk1 = 0;
      }
      const wk0 = 0.75;
      for (let j = 0; j < ny; j++) {
        const J = j >> 1;
        let J2 = j & 1 ? J + 1 : J - 1;
        let wj1 = 0.25;
        if (J2 < 0 || J2 >= cny) {
          J2 = J;
          wj1 = 0;
        }
        const wj0 = 0.75;
        const row = nx * (j + ny * k);
        const b00 = cnx * (J + cny * K);
        const b10 = cnx * (J2 + cny * K);
        const b01 = cnx * (J + cny * K2);
        const b11 = cnx * (J2 + cny * K2);
        for (let i = 0; i < nx; i++) {
          const c = row + i;
          const v = rr[c] * inv[c];
          if (v === 0) continue;
          const I = i >> 1;
          let I2 = i & 1 ? I + 1 : I - 1;
          let wi1 = 0.25;
          if (I2 < 0 || I2 >= cnx) {
            I2 = I;
            wi1 = 0;
          }
          const wi0 = 0.75;
          let q = b00 + I;
          if (cd[q] > 0) cb[q] += v * wi0 * wj0 * wk0;
          q = b00 + I2;
          if (wi1 !== 0 && cd[q] > 0) cb[q] += v * wi1 * wj0 * wk0;
          q = b10 + I;
          if (wj1 !== 0 && cd[q] > 0) cb[q] += v * wi0 * wj1 * wk0;
          q = b10 + I2;
          if (wi1 !== 0 && wj1 !== 0 && cd[q] > 0) cb[q] += v * wi1 * wj1 * wk0;
          q = b01 + I;
          if (wk1 !== 0 && cd[q] > 0) cb[q] += v * wi0 * wj0 * wk1;
          q = b01 + I2;
          if (wk1 !== 0 && wi1 !== 0 && cd[q] > 0) cb[q] += v * wi1 * wj0 * wk1;
          q = b11 + I;
          if (wk1 !== 0 && wj1 !== 0 && cd[q] > 0) cb[q] += v * wi0 * wj1 * wk1;
          q = b11 + I2;
          if (wk1 !== 0 && wj1 !== 0 && wi1 !== 0 && cd[q] > 0) cb[q] += v * wi1 * wj1 * wk1;
        }
      }
    }
  }

  private prolongAdd(F: Level, C: Level) {
    const x = F.x;
    const cx = C.x;
    const om = this.opts.omega;
    const diag = F.diag;
    const { nx, ny, nz } = F;
    const cnx = C.nx;
    const cny = C.ny;
    const cnz = C.nz;
    if (this.opts.prolongation === 'constant') {
      for (let k = 0; k < nz; k++) {
        const pk = cny * (k >> 1);
        for (let j = 0; j < ny; j++) {
          const pj = cnx * ((j >> 1) + pk);
          const row = nx * (j + ny * k);
          for (let i = 0; i < nx; i++) {
            const c = row + i;
            if (diag[c] > 0) x[c] += om * cx[(i >> 1) + pj];
          }
        }
      }
      return;
    }
    // solid coarse cells hold x = 0, so they drop out of the weighted sum automatically
    const inv = F.invW as Float32Array;
    for (let k = 0; k < nz; k++) {
      const K = k >> 1;
      let K2 = k & 1 ? K + 1 : K - 1;
      let wk1 = 0.25;
      if (K2 < 0 || K2 >= cnz) {
        K2 = K;
        wk1 = 0;
      }
      for (let j = 0; j < ny; j++) {
        const J = j >> 1;
        let J2 = j & 1 ? J + 1 : J - 1;
        let wj1 = 0.25;
        if (J2 < 0 || J2 >= cny) {
          J2 = J;
          wj1 = 0;
        }
        const row = nx * (j + ny * k);
        const b00 = cnx * (J + cny * K);
        const b10 = cnx * (J2 + cny * K);
        const b01 = cnx * (J + cny * K2);
        const b11 = cnx * (J2 + cny * K2);
        for (let i = 0; i < nx; i++) {
          const c = row + i;
          const s0 = inv[c];
          if (s0 === 0) continue;
          const I = i >> 1;
          let I2 = i & 1 ? I + 1 : I - 1;
          let wi1 = 0.25;
          if (I2 < 0 || I2 >= cnx) {
            I2 = I;
            wi1 = 0;
          }
          const plane0 = 0.75 * (0.75 * (0.75 * cx[b00 + I] + wi1 * cx[b00 + I2]) + wj1 * (0.75 * cx[b10 + I] + wi1 * cx[b10 + I2]));
          const plane1 = wk1 === 0 ? 0 : wk1 * (0.75 * (0.75 * cx[b01 + I] + wi1 * cx[b01 + I2]) + wj1 * (0.75 * cx[b11 + I] + wi1 * cx[b11 + I2]));
          x[c] += om * s0 * (plane0 + plane1);
        }
      }
    }
  }

  private cycle(l: number) {
    const L = this.levels[l];
    L.x.fill(0);
    if (l === this.levels.length - 1) {
      for (let s = 0; s < this.bottomSweeps; s++) {
        smooth(L, 0);
        smooth(L, 1);
      }
      for (let s = 0; s < this.bottomSweeps; s++) {
        smooth(L, 1);
        smooth(L, 0);
      }
      return;
    }
    const nu = this.opts.smooth;
    for (let s = 0; s < nu; s++) {
      smooth(L, 0);
      smooth(L, 1);
    }
    applyA(L, L.x, L.r);
    const { r, b } = L;
    for (let c = 0; c < L.n; c++) r[c] = b[c] - r[c];
    const C = this.levels[l + 1];
    this.restrict(L, C);
    this.cycle(l + 1);
    if (this.opts.cycle === 'W' && l + 1 < this.levels.length - 1 && C.tmp) {
      applyA(C, C.x, C.r);
      for (let c = 0; c < C.n; c++) C.b[c] -= C.r[c];
      C.tmp.set(C.x);
      this.cycle(l + 1);
      const cx = C.x;
      const t = C.tmp;
      for (let c = 0; c < C.n; c++) cx[c] += t[c];
    }
    this.prolongAdd(L, C);
    for (let s = 0; s < nu; s++) {
      smooth(L, 1);
      smooth(L, 0);
    }
  }

  private precondition(rIn: Float64Array, zOut: Float64Array) {
    const L0 = this.levels[0];
    L0.b.set(rIn);
    this.cycle(0);
    zOut.set(L0.x);
  }

  /**
   * Solve A x = b starting from the warm-start guess in x.
   * @param tol max-norm tolerance on the residual
   */
  solve(b: Float64Array, x: Float64Array, tol: number, maxIter: number): number {
    const L0 = this.levels[0];
    const { r, z, p, Ap } = this;
    const n = L0.n;
    const diag = L0.diag;
    applyA(L0, x, Ap);
    let rmax = 0;
    for (let c = 0; c < n; c++) {
      if (diag[c] <= 0) {
        r[c] = 0;
        x[c] = 0;
        continue;
      }
      const v = b[c] - Ap[c];
      r[c] = v;
      const a = v < 0 ? -v : v;
      if (a > rmax) rmax = a;
    }
    let it = 0;
    if (rmax > tol) {
      this.precondition(r, z);
      p.set(z);
      let rz = 0;
      for (let c = 0; c < n; c++) rz += r[c] * z[c];
      for (it = 1; it <= maxIter; it++) {
        applyA(L0, p, Ap);
        let pAp = 0;
        for (let c = 0; c < n; c++) pAp += p[c] * Ap[c];
        if (pAp <= 0) break;
        const alpha = rz / pAp;
        rmax = 0;
        for (let c = 0; c < n; c++) {
          x[c] += alpha * p[c];
          const v = r[c] - alpha * Ap[c];
          r[c] = v;
          const a = v < 0 ? -v : v;
          if (a > rmax) rmax = a;
        }
        if (rmax <= tol || it === maxIter) break;
        this.precondition(r, z);
        let rzNew = 0;
        for (let c = 0; c < n; c++) rzNew += r[c] * z[c];
        const beta = rzNew / rz;
        rz = rzNew;
        for (let c = 0; c < n; c++) p[c] = z[c] + beta * p[c];
      }
    }
    this.lastIterations = it;
    this.lastResidual = rmax;
    return rmax;
  }
}
