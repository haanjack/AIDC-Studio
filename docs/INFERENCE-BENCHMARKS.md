# Inference benchmark integration

AIDC Studio separates model architecture, analytical capacity modelling, and measured calibration. A model configuration supplies dimensions such as parameters, layers, attention shape, context limit, and expert topology. It does not supply achieved tokens per second, latency, batching efficiency, or framework overhead. Those values must come from a measured benchmark or a local measurement.

## InferenceX data path

The application uses the public, read-only InferenceX HTTP API:

```text
Workload preset
  -> exact InferenceX display-model mapping
  -> AIDC server proxy (/api/inferencex/benchmarks)
  -> public InferenceX API (/api/v1/benchmarks)
  -> local condition matching and ranking
  -> explicit user review and calibration
```

Single-turn throughput rows use the default benchmark view. AgentX cache traces use the calculator view with `sequence=agentic-traces`; the two result sets remain separate in the UI and in the stored workload.

The server proxy fixes the upstream origin, validates the local preset mapping, applies a timeout, limits the response, and caches it for 15 minutes. It does not require InferenceX database credentials. The browser never receives a database connection string.

The two upstream MCP implementations have different purposes and are not required by this integration:

- `InferenceX/.claude/mcp/server.py` exposes the vLLM or SGLang source tree at versions associated with benchmark runs. It is useful for implementation and provenance investigation, not for querying benchmark results.
- `InferenceX-app/packages/mcp` queries the benchmark database and requires `DATABASE_READONLY_URL`. Its tools include `get_overview`, `list_hardware`, `list_models`, `list_configs`, `get_latest_benchmarks`, and read-only `query_sql`. It is suitable for an agent or environment that has been granted database access.
- AIDC Studio uses the documented public benchmark API because it is credential-free, read-only, and sufficient for calibration rows.

The performance model consumes `InferenceXPublicRow[]`, not HTTP responses directly. `inferenceXRowsFromMcp` converts the MCP tool's flattened metrics and its separately returned filters to that common form. An authorised MCP client can therefore pass `get_latest_benchmarks` or `query_sql` results through the same model without changing the prediction logic. The browser application does not start an MCP stdio process or request database credentials. This keeps database authority outside the end-user UI while allowing an MCP-backed deployment later.

The current `get_latest_benchmarks` result omits TP/EP fields even though it returns GPU counts. For a topology-sensitive study, use read-only `query_sql` to include `prefill_tp`, `prefill_ep`, `decode_tp`, `decode_ep`, worker counts, and the required metrics, then normalise that payload. Missing topology is never equivalent to evidence for a particular TP/EP sweep.

For example, an authorised MCP client can request the complete Kimi K2.5 single-turn basis with a read-only query shaped like this:

```sql
SELECT lb.id,
       c.hardware, c.framework, c.model, c.precision, c.spec_method, c.disagg,
       c.prefill_tp, c.prefill_ep, c.prefill_num_workers,
       c.decode_tp, c.decode_ep, c.decode_num_workers,
       c.num_prefill_gpu, c.num_decode_gpu,
       lb.benchmark_type, lb.date, lb.isl, lb.osl, lb.conc,
       lb.offload_mode, lb.image, lb.recipe_fingerprint, lb.metrics
FROM latest_benchmarks lb
JOIN configs c ON c.id = lb.config_id
WHERE c.model = 'kimik2.5'
  AND lb.benchmark_type = 'single_turn'
ORDER BY c.hardware, c.framework, c.disagg, lb.isl, lb.osl, lb.conc;
```

The MCP response is JSON text inside its content block. Parse that JSON object, pass it with the exact public display name to `inferenceXRowsFromMcp`, and then call `predictInferenceXPerformance`. Database credentials remain in the MCP process; they are never sent to AIDC Studio's browser.

No InferenceX or InferenceX-app implementation code is embedded in AIDC Studio. The integration is an independent client of the public API contract.

## Exact model mappings

AIDC Studio maps only model generations that have an exact public InferenceX display name. It does not silently treat a related generation as equivalent. Current mappings include DeepSeek-R1-0528, DeepSeek-V4-Pro, GLM-5.2, Kimi-K2.5, Kimi-K3, MiniMax-M3, and gpt-oss-120b.

If a preset has no exact mapping, the UI keeps benchmark import disabled and still permits a user measurement. Update `packages/core/src/workload/inferencex.ts` when the public API adds an exact model.

## Row selection

Fetching data does not automatically apply a calibration. Rows are ranked and shown for review using these conditions:

1. Accelerator family of the GPU racks placed in Layout.
2. Weight precision, with INT4 treated as the FP4 capacity class but retained as INT4 in the source description.
3. Aggregated versus prefill/decode-disaggregated serving.
4. Distance from the configured input and output lengths.
5. TTFT and TPOT SLO compliance, using p99 when available.
6. Workload type and result age.

SLO-incompatible points receive a larger penalty than a cross-accelerator point. The table is never sorted by maximum throughput alone. Applying a cross-accelerator result remains visibly marked as an estimate; decode throughput is transferred using the catalogued HBM-bandwidth ratio when both sides have a value.

The calibration quantity is **output tokens/s per decode GPU** at the row's stated interactivity. In an aggregated run every GPU belongs to the shared decode-capable pool, so this is also output tokens/s per physical GPU. In a P/D-disaggregated run, InferenceX divides output throughput by decode GPUs only; prefill GPUs are not in that denominator. AIDC Studio uses this raw value only for decode-pool calibration. Physical accelerator scale remains prefill plus decode GPUs for P/D and the one shared pool for aggregated serving.

## Measurement-conditioned performance prediction

After loading public single-turn rows, AIDC Studio also builds a per-accelerator output-throughput estimate. It is deliberately a transparent local evidence model rather than a hardware peak-FLOPS claim:

1. Rows must match the exact model generation.
2. Each accelerator is modelled from its own measurements. Values are not transferred from another GPU.
3. Weight precision and aggregated versus P/D-disaggregated serving must match. A missing combination is shown as unavailable.
4. Repeated runs with the same hardware, framework, precision, serving mode, topology, GPU pool size, ISL, OSL and concurrency are median-aggregated into one condition. Date, image and run ID do not create a new validation condition.
5. The target is compared in logarithmic ISL, OSL, measured interactivity, TP, EP and physical-accelerator-count space. A weighted geometric nearest-neighbour estimate is used because throughput ratios, rather than additive differences, are the useful scale.
6. The tool removes an entire condition at a time and predicts it from the remaining conditions. It reports median and p90 absolute percentage error across those held-out conditions.

The displayed planning band combines the local log-throughput spread with the held-out p90 error and a minimum run-variance allowance. It is an empirical design range, not a confidence interval. Coverage is labelled as near-measurement, interpolation, extrapolation, high held-out variance, a single-condition result, or unavailable. A p90 held-out error above 50% is labelled high variance even when the target is geometrically close to a measurement. A prediction with only one comparable condition cannot be applied as a calibration row.

Only near-measurement and interpolated predictions can become a derived calibration row. Extrapolated or high-variance predictions remain visible for diagnosis but cannot be applied; select a measured row or supply a project measurement instead.

This structure makes a measured-versus-predicted comparison explicit. It does not make different frameworks, scheduler policies or quantisation recipes equivalent. A model with a small validation set can be useful for preliminary comparison while still being unsuitable for an acceptance guarantee.

## Cross-model workload interpretation

The benchmark calibration card above answers “which measured point may be used as evidence?” It does not interpret an arbitrary selected workload. The **Analyse this workload** action in the Simulation result has a different purpose:

```text
Selected workload and placed cluster
  -> enumerate feasible aggregated and P/D topologies
  -> sweep TP / EP / PP / CP, integer DP allocation and interactivity target
  -> reject HBM-infeasible placements
  -> calculate compute, HBM and communication rooflines
  -> apply the InferenceX-learned efficiency residual
  -> cap by the project's scale-up / scale-out network capacity
  -> keep the non-dominated throughput-versus-interactivity frontier
```

This path can analyse a preset with no exact InferenceX model mapping. It never substitutes a related benchmark row as though it were the selected model. Instead it starts from the selected model's own parameters and structure, uses the placed accelerator specifications, and labels the result as model extrapolation when that model family was absent from training.

### Hybrid physical and measured model

The cross-model estimator uses a standardised ridge regression on the logarithmic residual between measured facility-normalised output throughput and a first-order harmonic compute/HBM roofline. Training the residual rather than raw throughput preserves a physical baseline for a new model or accelerator and asks the regression to learn observed implementation efficiency and overhead.

The feature vector contains no model-name or accelerator-name shortcut. It includes:

- accelerator peak throughput for the selected precision, HBM bandwidth and capacity, and the effective fabric bandwidth selected from the native scale-up domain or scale-out NIC path;
- total and active parameter counts, active fraction, layers, hidden size, KV bytes/token, expert count and top-K, and MLA presence;
- ISL, OSL and measured interactivity;
- TP, EP, PP, CP, physical pool size, concurrency per GPU, P/D mode, attention-DP and speculative-decoding presence;
- explicit compute, HBM and harmonic roofline terms.

Public rows are grouped by physical condition: model, accelerator, precision, serving mode, request shape, parallelism, GPU pools, worker layout, concurrency, offload and speculative mode. Framework/container revisions inside that condition do not pretend to add architectural coverage. Their median stabilises the target, their robust log spread becomes implementation uncertainty, and their training weight is capped at 1.5×. A divergent multi-implementation condition is down-weighted; a popular benchmark shape cannot dominate the fit merely because more teams submitted it. For P/D data, the InferenceX decode-GPU throughput is converted to total output divided by all prefill plus decode GPUs before fitting. This makes the predicted quantity comparable across aggregated and disaggregated facility layouts.

The workload sweep uses the regression estimate only for compute-side output capacity. It independently recomputes topology-dependent collective and KV-transfer traffic with the AIDC network model and applies the network capacity as a hard cap. Exact project calibration, when its workload signature matches, takes precedence over regression.

### Validation and uncertainty

Random row splitting would leak nearly identical runs and produce misleadingly small errors. AIDC Studio therefore reports two more demanding validations:

- leave-one-model-out: remove every condition for one model family, fit on the others, and predict the unseen model;
- leave-one-accelerator-out: remove every condition for one accelerator family and predict it from published hardware characteristics plus the remaining measurements.

The displayed planning band uses the largest of implementation-spread p90, applicable domain-holdout p90 and a 25% minimum allowance. A target is separately marked as represented in evidence or as a model/hardware extrapolation. The band is a planning sensitivity range, not a statistical confidence interval and not an acceptance-test guarantee.

In the public-data snapshot queried on 2026-09-17, 1,807 usable single-turn runs reduced to 1,635 physical conditions across DeepSeek-R1, gpt-oss-120b and Kimi K2.5, with eight accelerator families. There were 172 additional framework/container implementations over 172 shared physical conditions. Their robust implementation spread was 5.6% median and 20.9% p90. The weighted roofline-residual model produced these domain-holdout summaries:

| Held-out domain | Median absolute percentage error | p90 absolute percentage error |
| --- | ---: | ---: |
| Entire model family | 32.3% | 70.4% |
| Entire accelerator family | 19.2% | 56.2% |

The result is useful for comparative planning and for revealing sensitivity to parallelism and fabric choices, but the unseen-model tail remains broad. More independent model families, exact runtime/topology fields and project measurements are needed before treating it as a procurement or acceptance forecast. The application exposes the live validation counts and errors alongside every generated Pareto graph so a newer InferenceX dataset can improve—or worsen—the visible evidence quality without silently changing the claim.

## Parallelism and placed pools

TP, PP, EP and CP describe how one model replica is sharded. DP is different: it is the number of independent replicas in a serving pool. In P/D-disaggregated mode, prefill DP and decode DP can therefore be set independently. A value of `0` or an omitted DP lets the simulator allocate whole replicas within the GPUs placed in Layout; a positive value requests a fixed stage pool.

TP and EP do not necessarily multiply the physical worker count. In common SGLang/vLLM MoE serving layouts, both collectives run over the same worker group, so AIDC Studio's default **shared TP/EP workers** mapping uses `max(TP, EP) × PP × CP` physical GPUs. This matches InferenceX rows such as TP4/EP4 on four prefill GPUs and TP8/EP8 on eight decode GPUs. Select **orthogonal TP × EP grid** only when the deployed runtime really creates independent TP and EP dimensions; that mode uses `TP × EP × PP × CP` GPUs. The HBM model distributes one complete copy of the weights over the resulting worker group.

The result deliberately separates two quantities:

- **target-demand sizing** is the analytical number of prefill and decode replicas needed for the configured request rate and SLO;
- **placed DP** is the number of whole replicas that actually fit in the allocated cluster and determines simulated served throughput.

A topology such as TP16 × EP8 is a 16-GPU worker group under the default shared mapping and a 128-GPU group under the explicitly selected orthogonal mapping. If the physical replica or either collective exceeds the platform's native scale-up domain, the result is labelled as a scale-out analytical sensitivity rather than benchmark-validated performance. Increasing DP cannot repair an unsuitable per-replica topology.

An applied inference calibration is bound to the model generation, request shape, precision, serving mode and per-replica topology. Changing those conditions excludes the old calibration until a matching InferenceX point or user measurement is applied again. Request rate and DP are not part of that signature because they scale the number of otherwise identical replicas.

### P/D and network studies

The next modelling layer can sweep independent prefill and decode TP/EP, pool sizes, ISL/OSL, concurrency and SLO. For every supported point, the measurement-conditioned model supplies output capacity while the existing traffic engine calculates tensor/expert collectives and prefill-to-decode KV transfer. This can recreate the shape of a published P/D scaling graph and project fabric demand, but only measured or interpolated regions should be compared as validation. Extrapolated points must remain visually distinct, and a keynote chart should be digitised or imported with its stated test conditions before claiming numerical reproduction.

### Measured parallelism sweep and interactivity / throughput envelopes

The workload panel also constructs a GTC-style Pareto view directly from InferenceX single-turn measurements. For the selected model generation, placed accelerator, precision and nearest ISL/OSL shape, it sweeps the configurations that were actually measured: TP, EP, attention-DP, prefill/decode worker counts and pool sizes, concurrency, runtime, and speculative-decoding method. The public rows currently do not expose varying PP or CP evidence, so the tool does not invent a PP/CP sweep. This view is separate from the nearest-neighbour predictor above:

- x-axis: measured output interactivity in tokens/s/user (`median_intvty`, falling back to `1 / median_tpot`);
- raw InferenceX quantity: measured `output_tput_per_gpu`, which means output tokens/s/decode-GPU for P/D;
- facility-normalised y-axis: reconstructed total output divided by all GPUs in the measured serving unit;
- cluster y-axis: complete measured serving units repeated on the accelerators placed in Layout, with fractional units forbidden and leftover GPUs shown as idle;
- efficiency y-axis: reconstructed total output divided by measured total GPU power, in output TPS/MW; role-specific prefill/decode power is used when available;
- series: aggregated serving and P/D-disaggregated serving remain separate;
- point identity: framework, precision, specification method, TP/EP, worker and pool counts, ISL/OSL, concurrency and offload mode;
- envelope: only measured points not dominated on both interactivity and the selected y metric are connected.

Repeated executions of an identical condition are reduced to medians before the Pareto filter. The graph does not fit a smooth curve through the points. A run with invalid audit reasons, `power_valid = 0`, missing power, or non-positive power remains eligible for throughput graphs but is excluded from TPS/MW; power is never inferred to complete the efficiency series.

The cluster curve is a replication projection, not a benchmark at the full placed-cluster scale. It preserves the measured P/D pool ratio and multiplies only complete units. It therefore answers “which measured serving configuration best fills this accelerator pool?” without claiming linear scale-out across a partially filled or differently networked deployment.

For each serving mode, the closest available measured ISL/OSL pair is selected. When the request shapes differ, the UI explicitly warns that the vertical separation is not a valid P/D uplift. Even when ISL/OSL matches, the frontier points may use different runtimes, topologies, pool ratios, concurrency and speculative methods; the UI therefore also states that the gap is not a controlled P/D uplift unless those conditions are matched. The configured TPOT target appears as a vertical reference only when it falls inside the measured interactivity range.

The visual form is inspired by the familiar interactivity-versus-throughput trade-off used in vendor presentations, but the plotted points and run links are SemiAnalysis InferenceX evidence. It is not a reconstruction or validation of an NVIDIA keynote claim. A published vendor graph requires its original numeric points and complete test conditions before it can be used as a comparison dataset.

### DeepSeek-R1 validation snapshot

On 2026-09-17, the public `DeepSeek-R1-0528` response contained 1,310 rows across the supported accelerator families, including 307 MI355X rows. Filtering to MI355X, FP4 and the exact 8,192-input / 1,024-output single-turn shape produced 30 aggregated and 25 P/D measured conditions. The observed sweep covered TP 4/8, EP 1/8, attention-DP off/on, one or two workers, 4/8/16-GPU stage pools, 14 concurrency levels, and `none`/`mtp` speculative modes.

On a 256-MI355X placed pool, integer replication of those measured units produced monotonic, non-dominated envelopes. The aggregated frontier ranged from about 125,019 output tok/s at 7.8 tok/s/user to 21,174 at 177.2 tok/s/user. The P/D frontier ranged from about 232,333 output tok/s at 51.8 tok/s/user to 8,449 at 350.6 tok/s/user. These values are a deterministic transformation of measured units, not a new 256-GPU benchmark.

The broader nearest-neighbour predictor was deliberately not treated as validation: across 67 comparable MI355X condition groups its condition-level holdout median absolute percentage error was 48.4% and p90 was 137.2%. That result is labelled **high variance** and cannot be applied as a calibration. The Pareto view therefore uses the measured configurations themselves rather than this predictor.

The same 256-accelerator validation was repeated for NVIDIA B200 and B300 using a fresh response from the same public endpoint on 2026-09-17:

| Accelerator | Public rows | Exact-shape measured conditions | Aggregated cluster frontier | P/D cluster frontier | Predictor holdout median / p90 |
| --- | ---: | ---: | --- | --- | ---: |
| B200 | 350 | 36 aggregated + 45 P/D | 304,696 tok/s at 20.0 tok/s/user → 18,988 at 298.4 | 376,278 at 29.9 → 4,678 at 300.8 | 54.5% / 200.4% |
| B300 | 129 | 13 aggregated + 13 P/D | 160,549 tok/s at 20.5 tok/s/user → 5,333 at 170.7 | 444,693 at 26.0 → 9,153 at 318.6 | 51.5% / 187.2% |

Both measured frontiers are monotonic after dominance filtering and contain multiple topology/concurrency regimes rather than one duplicated run. The lower aggregated B300 frontier must not be read as B300 being slower than B200: the available B300 aggregated rows use a different mix of runtime, topology, pool size and concurrency. For both NVIDIA GPUs the broad predictor is also **high variance**, so the application keeps it diagnostic-only and uses measured points for the Pareto view.

## Prefix caching

The inference workload distinguishes:

- `inputTokens`: complete prompt length presented to the model;
- `cachedPrefixTokens`: leading prompt tokens whose KV state is already warm and reusable;
- `inputTokens - cachedPrefixTokens`: prompt tokens that require new prefill work;
- `outputTokens`: newly decoded tokens.

For a fixed-prefix scenario, AIDC Studio applies the following neutral planning assumptions:

```text
new prefill tokens = max(0, inputTokens - cachedPrefixTokens)
logical served tokens = inputTokens + outputTokens
newly computed tokens = new prefill tokens + outputTokens
```

New prefill compute and prefill collective traffic use the uncached input. In P/D mode, newly produced KV is transferred from prefill to decode. Resident KV memory still uses the complete input plus output context because cached KV has not disappeared; it must remain available to be reused.

Single-turn InferenceX rows calibrate decode output throughput only. AIDC Studio does not infer prefix-cache benefit from those rows.

AgentX rows replay multi-turn agentic traces and expose measured cache counters. They can be loaded and explicitly applied as a separate trace calibration. The stored calibration preserves accelerator, framework, precision, serving mode, concurrency, offload mode, measurement date, source, and these rates:

- GPU cache hit;
- CPU/host cache hit, when reported;
- external cache hit, when reported;
- theoretical cache-hit ceiling, when reported.

When a trace calibration is active, it supersedes the fixed `cachedPrefixTokens` scenario:

```text
GPU-cached tokens    = inputTokens × gpuHitRate
remote-cached tokens = inputTokens × max(cpuHitRate, externalHitRate)
new prefill tokens   = inputTokens - GPU-cached tokens - remote-cached tokens
```

The remote rate is capped so total hit does not exceed 100%. CPU and external counters are not added because a serving backend may expose overlapping views of the same host-side reuse. Remote-cache KV retrieval is included as a conservative scale-out traffic proxy in both aggregated and P/D serving. P/D serving additionally transfers KV for newly computed prompt tokens. Actual PCIe/CXL/NIC routing, cache eviction, object-store protocol, contention, and retrieval latency still require deployment-specific measurement.

AgentX concurrency is a concurrent-user point, not the workload request rate. AIDC Studio therefore shows the concurrency curve for explicit selection and never silently chooses a point. Trace calibration and output-throughput calibration are independent: applying one does not overwrite the other. Some mapped models currently have no public AgentX rows; the UI reports that absence instead of borrowing another model generation.

## Reproducibility and limits

Each imported row retains the relevant API query, run URL, date, framework, topology, precision, concurrency, latency, cache counters, and source classification. InferenceX is continuously updated, so re-query before issuing a design basis. A public benchmark is still not a guarantee for a different runtime build, scheduler, topology, quantisation recipe, request distribution, cache policy, or scale. Acceptance sizing should be replaced or checked with project-specific measurements whenever possible.

## Credit and non-affiliation

Benchmark data and run provenance are credited to [SemiAnalysis InferenceX](https://inferencex.semianalysis.com/) and its [public benchmark repository](https://github.com/SemiAnalysisAI/InferenceX). AIDC Studio's matching, interpolation, planning bands and holdout-error analysis are independent derived work. AIDC Studio is not affiliated with, sponsored by or endorsed by SemiAnalysis. No InferenceX benchmark data is bundled in the repository; results are queried from the public service or supplied by an authorised MCP client at runtime.
