# @aidc/thermal — data-hall airflow & thermal solver

> 상면(white space) 레이아웃에서 바로 3D 기류·온도장을 계산하는 경량 CFD 솔버. 브라우저(Web Worker)와 Node에서 동일하게 동작하며, 외부 의존성이 없다.

A fast, dependency-free 3D airflow and heat-transport solver for AI data halls. It builds its domain directly from an AIDC Studio `Project` (halls, equipment, containment, keepouts) and runs unchanged in a Web Worker or in Node (`src/` uses no Node APIs).

It is a **design-stage** tool: minutes-scale, coarse-grid (0.2–0.5 m), steady-state oriented. It answers questions such as "does hot-aisle containment keep every intake under 27/32 °C?", "what happens without containment / blanking panels?" and "are the CRAHs sized and placed correctly?". It does not replace a validated commercial CFD study (see *Limitations*).

## Quick start

```ts
import { createNvidiaReferenceProject } from '@aidc/core';
import { runThermal } from '@aidc/thermal';

const { project } = createNvidiaReferenceProject();
const result = await runThermal(project, { hallId: 'hall-a', cellSize: 0.3, loadFactor: 1 }, {
  onProgress: (m) => console.log(m.step, m.maxInletC.toFixed(1)),
});
console.log(result.metrics.maxInletC, result.metrics.rciHi, result.metrics.balanceError);
```

Web Worker:

```ts
// thermal.worker.ts
import { handleThermalWorkerMessage, type ThermalWorkerRequest } from '@aidc/thermal';
self.onmessage = (e: MessageEvent<ThermalWorkerRequest>) =>
  handleThermalWorkerMessage(e.data, (msg, transfer) => (self as DedicatedWorkerGlobalScope).postMessage(msg, transfer ?? []));
```

Post `{ type: 'run', jobId, project, options, snapshotEvery }` and receive `progress` (metrics + optional `ThermalResult` snapshot every N steps, buffers transferred), then `done` or `error` (`message: 'cancelled'` after `{ type: 'cancel', jobId }`). The solver yields to the event loop every ~50 ms of work, so cancel is honored promptly.

Scripts:

```bash
npx vitest run packages/thermal                                   # tests (~1 min)
npx tsx packages/thermal/scripts/run-reference.ts [--quick]   # reference-hall benchmark
```

## Options

| option | meaning |
|---|---|
| `cellSize` | cubic cell edge in m (default 0.3) |
| `loadFactor` | IT utilization; rack air heat = nameplate × LF × (1 − liquidFraction); `EquipmentInstance.loadFactor` overrides per rack |
| `supplyAirC` | CRAH supply set-point (default `project.cooling.supplyAirC`) |
| `maxSteps`, `tolerance` | pseudo-time step cap (600) and drift tolerance in °C/step (0.01) |
| `region` | plan sub-rectangle; walls at the region boundary |
| `includePlenum` | model the ceiling return plenum (default: when `hall.ceilingPlenumHeight > 0`) |
| `overrides.containment` | `'none'` removes all containment (what-if) |
| `overrides.blanking` | force blanking panels on/off for every rack |
| `airHeatOverridesKW`, `airflowOverridesM3s` | per-equipment air heat / airflow (measured data, custom gear) |
| `coolerAirflowRatio` | CRAH airflow ÷ IT airflow demand (default 1.1), capped by unit capacity |
| `coolerReturn` | `'plenum'` (ducted, default with plenum) or `'top'` (unit-top return in the room) |
| `ceilingOpenings` | extra open ceiling areas (return grilles) as plan rectangles |

## Domain and geometry

* **Grid.** Uniform cubic cells, `index = i + nx*(j + ny*k)`; `i` → plan x, `j` → plan y, `k` → up. `origin` is the hall-local plan position of the grid min corner, floor at z = 0. Height = `clearHeight + ceilingPlenumHeight`.
* **Equipment.** Every placed item whose footprint intersects the domain is rasterized (cells whose centers fall inside the rotated footprint, at least one cell) and is solid. Rack-scale gear keeps its catalog footprint (0.6 × 1.2 × 2.3 m for GB300 NVL72).
* **Keepouts.** `column` and `shaft` are solid through the plenum; `other` (partitions) stops at the suspended ceiling; doors / egress / ramps are ignored.
* **Suspended ceiling.** When a plenum exists, the ceiling plane is a blocked face layer except for: (1) chimney openings above ducted hot-aisle containment, (2) return grilles over the exhaust zone (rack width × 1.2 m) of every rack that does not exhaust into active containment, (3) `ceilingOpenings`. If nothing is open, a sparse grille grid is used so the plenum is never sealed.
* **Containment** (thin walls on MAC faces, no cell thickness): side walls along both long edges, end doors, roof at containment height. Ducted HAC gets chimney walls from the roof to the ceiling and an open ceiling above. End doors keep a **one-cell undercut at the floor** — the leakage path that carries CRAH oversupply into the hot aisle, or hot air back out when cooling is short. CAC without a raised floor keeps a perforated roof (a warning is issued), because raised-floor supply is not modeled.
* **CRAH returns** are ducted: a solid column from the unit top to the ceiling, with volumetric sinks in the first plenum layer above the footprint. Without a plenum (or `coolerReturn: 'top'`) air returns through the unit top faces.
* **Connectivity check.** Air volumes are labeled (union–find over open faces). Warnings are issued when a rack's inlet and exhaust, or a CRAH's supply and return, end up in disconnected volumes.
* **Region crops without CRAHs** get virtual cooling: supply through the x-boundaries below 2 m, return through the top layer.

## Devices (boundary conditions)

| device | model |
|---|---|
| IT racks (GPU / CPU / storage / mgmt) | Front face sinks Q, rear face sources Q at `T_in,avg + airKW / (ρ c_p Q)`. Q comes from the catalog `airflowCurve` (evaluated at the current inlet temperature) or `airflowM3s`, × max(0.4, LF) for fan turndown, relaxed 20 %/step. |
| Network racks | 25 kW air heat (override per id), airflow for ΔT = 12 K, no fan turndown. |
| Blanking panels missing | 8 % of the exhaust recirculates internally: reported intakes are raised by 0.08 ΔT (the room energy balance is unchanged). |
| In-row CDUs | Cabinet airflow front-to-back carrying 15 % of nameplate (pump/drive losses) at ΔT = 12 K; excluded from IT intake metrics. |
| CRAH / fan wall | Supply through the lower 55 % of the front face at the set-point; airflow = `coolerAirflowRatio` × IT demand ÷ units, within [15 %, 100 %] of capacity; return per above. If the load exceeds coil capacity, the supply temperature rises to `T_return − capacity / (ρ c_p Q)`. |

All device faces are *fixed-flux* MAC faces (flag 2); walls and solids are blocked faces (flag 1).

## Numerical method

Pseudo-transient march to a statistically steady state.

1. **Devices.** Update rack inlet temperatures, airflows, exhaust temperatures, CRAH flows and return temperatures; write fixed face velocities and their inflow temperatures.
2. **Momentum.** Semi-Lagrangian advection of the staggered velocities (trilinear sampling, face velocities averaged to the face). Blocked faces stay 0 and fixed faces keep their values, giving no-slip-like drag near solids and jets at device faces. The time step is CFL = 2.5 on the fastest device face, clamped to [0.05, 1] s.
3. **Buoyancy.** Boussinesq, `w += Δt g β (T_face − T_supply)` with β = 1/T_abs.
4. **Projection.** `Σ_open (φ_c − φ_nb) = h (S/h² − Σ u_out)` with volumetric sinks S (CRAH returns). The RHS is made compatible per connected volume (mean removal), with one anchor cell per volume. Solved by **MG-preconditioned CG**: piecewise-constant aggregation, Galerkin coarse operators, symmetric red–black Gauss–Seidel, V-cycle, over-correction ω = 1.7. The solve is warm-started, capped at 10 iterations, with tolerance 1e-3·h, so partial solves converge over pseudo-time. A trilinear / rediscretized hierarchy and W-cycles are also implemented (`SolverTuning.mg`). On these geometries they reduce the residual about as well per unit of work, because the slow modes are small, weakly connected pockets rather than smooth modes.
5. **Energy.** Implicit, conservative, first-order upwind finite volume, `V/Δt_T (T − T_old) + Σ_f F_f T_upwind − Σ_open κh (T_nb − T) + S T = q/(ρ c_p)`. It uses one Gauss–Seidel sweep per step, alternating direction, with `Δt_T = 6 Δt` and κ = 0.01 m²/s. Fixed faces import their inflow temperature and walls are adiabatic. The diagonal uses `max(outflow + sink, inflow)` so the update stays bounded while the pressure solve is still converging. With a converged flux field this is exactly conservative, which is what closes the energy balance.
6. **Averaging & convergence.** Temperature and face velocities are exponentially time-averaged over ~30 steps, and reported fields and metrics use the averages. The residual is the drift of the averaged rack intakes and CRAH returns, compared 20 steps apart (°C/step). The run is converged when the drift stays below `tolerance` for 10 consecutive steps after step 80.

All arrays are preallocated typed arrays, with no per-step allocations in the kernels.

## Metrics

* `maxInletC` / `avgInletC` — IT intake max/avg (time-averaged cells adjacent to the inlet faces).
* `rciHi` / `rciLo` — Rack Cooling Index (Herrlin), ASHRAE A1: recommended 18–27 °C, allowable 15–32 °C, evaluated on each rack's max intake.
* `rti` — Return Temperature Index = (T_return − T_supply)/ΔT_IT × 100 (≈100 balanced, < 100 bypass, > 100 recirculation).
* `shi` — Supply Heat Index = Σ Q(T_in − T_sup) / Σ Q(T_ex − T_sup).
* `airHeatKW`, `removedKW`, `balanceError` — injected air-side heat vs enthalpy removed by CRAHs.
* `hotspots` — up to 10 hottest occupied-zone cells outside contained hot aisles, ≥ 1 m apart.

## Verification

See the numbers below (regenerate with `scripts/run-reference.ts`). Node 24, single thread, measured 2026-09-13.

**Reference hall** (`createNvidiaReferenceProject`, hall-a 21.6 × 37.2 m, 6 m clear + 2.38 m plenum, 96 × GB300 NVL72 + services, HAC ducted, 10 × CW375):

| run | cells | steps | ms/step | total | max inlet | avg inlet | RCI-HI | RTI | SHI | balance | DU01 hot aisle | plenum | cold aisle |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0.3 m · LF 1.0 · HAC | 250 k | 209 ✓ | 86 | 18 s | 31.1 °C | 24.5 | 94.9 | 90 | 0.030 | 0.6 % | 38.1 | 39.3 | 24.0 |
| 0.3 m · LF 0.4 · HAC | 250 k | 235 ✓ | 98 | 23 s | 31.9 °C | 24.8 | 88.6 | 89 | 0.053 | 1.5 % | 34.7 | 37.5 | 24.1 |
| 0.3 m · LF 1.0 · **no containment** | 250 k | 600 (drift) | 67 | 41 s | 40.5 °C | 26.9 | 40.3 | 90 | 0.164 | 0.2 % | 39.5 | 37.2 | 26.4 |
| 0.2 m · LF 1.0 · HAC | 844 k | 244 ✓ | 364 | 89 s | 29.0 °C | 24.4 | 97.9 | 90 | 0.024 | 0.5 % | 39.3 | 39.9 | 24.1 |

Accuracy is checked by the unit tests (energy balance, containment and topology cases in `packages/thermal/test`); the solver is not calibrated against any third-party CFD dataset shipped with the product.

## Limitations

* Coarse grid + first-order upwind energy transport: sharp plumes and jets are smeared. Keep ≥ 2 cells across aisles; 0.3 m for sizing, 0.2 m for layout decisions.
* No turbulence model beyond a constant effective diffusivity and the numerical diffusion of semi-Lagrangian advection.
* Rack internals are black boxes (uniform face flow); no server-level flow resistance or door perforation model. Containment leakage is a fixed door undercut, not a pressure–leakage curve.
* No raised-floor plenum / perforated tiles, no radiation, no humidity, no transient (failure-scenario) timing — pseudo-time is not physical time.
* Liquid-cooled heat (CDU/TCS) is not part of the air solve; only the air-side fraction is.
