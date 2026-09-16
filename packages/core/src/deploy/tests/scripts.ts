// Shell scripts of the acceptance test kit (stream T7). Commands follow the public tool documentation (verified tool
// options); lines marked "verify:" use syntax not confirmed in a fetched document. Every script passes `bash -n`.
// Shell text is kept in plain string arrays (no template interpolation) so ${VAR} stays literal.
import type { TestKitModel } from './model.ts';

const j = (lines: string[]) => lines.join('\n') + '\n';
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export const COMMON_SH = j([
  '#!/usr/bin/env bash',
  '# Common settings for the AIDC Studio acceptance test kit. Source this file from every stage script.',
  'set -euo pipefail',
  'KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
  'export KIT_DIR',
  'export LOG_DIR="${LOG_DIR:-${KIT_DIR}/logs}"',
  'export RUN_ID="${RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"',
  'export RESULTS_DIR="${RESULTS_DIR:-${KIT_DIR}/results/${RUN_ID}}"',
  'mkdir -p "${LOG_DIR}" "${RESULTS_DIR}"',
  'SSH="${SSH:-ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new}"',
  'export SSH',
  'log() { printf "[%s] %s\\n" "$(date -u +%H:%M:%S)" "$*" >&2; }',
  'hosts_of() { grep -v "^#" "${KIT_DIR}/inventory/hostfiles/$1.txt" | sed "/^$/d"; }',
]);

export function runAllSh(): string {
  return j([
    '#!/usr/bin/env bash',
    '# Run order: 00 → 10 → 20 → 30 → 40 → 50 → 60 (60 polls in the background during 30 and 40).',
    '# Complete node-level steps on one representative system first, then replicate (AMD acceptance guide).',
    'set -euo pipefail',
    'source "$(dirname "${BASH_SOURCE[0]}")/common.sh"',
    'STAGES="${STAGES:-00-inventory 10-links 20-rdma 30-collectives 40-node 50-storage 60-thermal-power}"',
    'for stage in ${STAGES}; do',
    '  log "stage ${stage}"',
    '  for script in "${KIT_DIR}/${stage}"/*.sh; do',
    '    [ -e "${script}" ] || continue',
    '    case "$(basename "${script}")" in _*) continue ;; esac',
    '    bash "${script}" || log "stage ${stage}: $(basename "${script}") failed"',
    '  done',
    'done',
    'python3 -m pytest -q --run-id "${RUN_ID}" "${KIT_DIR}" || true',
    'log "results: ${RESULTS_DIR}/results.json"',
  ]);
}

export function inventorySh(m: TestKitModel): string {
  const gpu = m.vendor === 'amd' ? 'rocm-smi --showallinfo --json' : 'nvidia-smi -q -x';
  const nicId = m.vendor === 'amd' ? '1dd8:43c6' : '15b3:1021';
  return j([
    '#!/usr/bin/env bash',
    '# 00-inventory: collect GPU / NIC / firmware / address inventory from every node → logs/inventory/<host>/',
    '# AMD topology mapping: lspci -d <gpu id> -PP and lspci -d <nic id> -PP pair each GPU with the NIC under the same root port.',
    'source "$(dirname "${BASH_SOURCE[0]}")/../common.sh"',
    'OUT="${LOG_DIR}/inventory"; mkdir -p "${OUT}"',
    'for h in $(hosts_of all); do',
    '  mkdir -p "${OUT}/${h}"',
    `  \${SSH} "\${h}" ${q(gpu)} > "\${OUT}/\${h}/gpu.txt" 2>&1 || log "\${h}: GPU query failed"`,
    '  # verify: standard tools, options not quoted from a fetched document',
    '  ${SSH} "${h}" "ibv_devinfo -v" > "${OUT}/${h}/ibv_devinfo.txt" 2>&1 || true',
    '  ${SSH} "${h}" "ip -j addr" > "${OUT}/${h}/ip-addr.json" 2>&1 || true',
    `  \${SSH} "\${h}" ${q(`lspci -d ${nicId} -PP`)} > "\${OUT}/\${h}/lspci-nic.txt" 2>&1 || true`,
    'done',
    'log "inventory written to ${OUT}"',
  ]);
}

export function lldpSh(): string {
  return j([
    '#!/usr/bin/env bash',
    '# 10-links: LLDP neighbours from every switch → logs/lldp/<switch>.txt, compared with inventory/expected-links.csv by test_links.py.',
    '# usage: NOS=sonic|cumulus-nvue|arista-eos|cisco-nxos|dell-os10|juniper-junos bash lldp_collect.sh',
    'source "$(dirname "${BASH_SOURCE[0]}")/../common.sh"',
    'NOS="${NOS:-sonic}"',
    'OUT="${LOG_DIR}/lldp"; mkdir -p "${OUT}"',
    'case "${NOS}" in',
    '  sonic) CMD="show lldp table" ;;',
    '  cumulus-nvue) CMD="nv show system lldp" ;;',
    '  # verify: "show lldp neighbors" for EOS / NX-OS / Junos / Dell is standard CLI, not quoted from a fetched document',
    '  arista-eos|cisco-nxos|juniper-junos|dell-os10) CMD="show lldp neighbors" ;;',
    '  *) log "unknown NOS ${NOS}"; exit 2 ;;',
    'esac',
    'cut -d, -f1 "${KIT_DIR}/inventory/switches.csv" | tail -n +2 | tr -d "\\r\\"" | while read -r sw; do',
    '  [ -n "${sw}" ] || continue',
    '  ${SSH} "${sw}" "${CMD}" > "${OUT}/${sw}.txt" 2>&1 || log "${sw}: LLDP query failed"',
    'done',
    '# Cumulus PTM alternative: copy topology.dot from the deployment bundle to /etc/ptm.d/ and run ptmctl on each switch.',
  ]);
}

export function countersSh(m: TestKitModel): string {
  return j([
    '#!/usr/bin/env bash',
    '# 10-links: NIC counters before / after a soak (ethtool -S) and optics / eye (mlxlink) → logs/links/<phase>/<host>-<nic>.txt',
    '# usage: PHASE=before|after bash link_counters.sh',
    'source "$(dirname "${BASH_SOURCE[0]}")/../common.sh"',
    'PHASE="${PHASE:-before}"',
    'OUT="${LOG_DIR}/links/${PHASE}"; mkdir -p "${OUT}"',
    `NICS="\${NICS:-${m.nicNames.join(' ')}}"`,
    'for h in $(hosts_of all); do',
    '  for nic in ${NICS}; do',
    '    # kernel mlx5 counters [V names]: rx_crc_errors_phy rx_symbol_err_phy link_down_events_phy rx_discards_phy rx_prio3_pause_duration',
    '    ${SSH} "${h}" "ethtool -S ${nic}" > "${OUT}/${h}-${nic}.txt" 2>&1 || true',
    '  done',
    ...(m.vendor === 'nvidia' ? ['  # mstflint mlxlink options: -d -m -c -e --json', '  ${SSH} "${h}" "mlxlink -d mlx5_0 -m -c -e --json" > "${OUT}/${h}-mlxlink.json" 2>&1 || true'] : []),
    'done',
  ]);
}

export function linkFlapSh(): string {
  return j([
    '#!/usr/bin/env bash',
    '# 10-links: link-flap test (DriveNets/AMD RA §11.2): ~5 % of the listed switch ports down for 5 s at random during a 10-min ib_write_bw run.',
    '# usage: _link_flap.sh <switch> <ifaces.txt> [minutes]   (leading underscore: not run by run_all.sh; needs a traffic run in parallel)',
    'source "$(dirname "${BASH_SOURCE[0]}")/../common.sh"',
    'SW="${1:?switch hostname}"; LIST="${2:?file with one interface per line}"; MIN="${3:-10}"',
    'NOS="${NOS:-sonic}"',
    'END=$(( $(date +%s) + MIN * 60 ))',
    'mapfile -t PORTS < "${LIST}"',
    'N=$(( (${#PORTS[@]} + 19) / 20 ))',
    'flap() {',
    '  case "${NOS}" in',
    '    sonic) ${SSH} "${SW}" "sudo config interface shutdown $1; sleep 5; sudo config interface startup $1" ;;',
    '    # verify: NVUE link state syntax not quoted from a fetched document',
    '    cumulus-nvue) ${SSH} "${SW}" "nv set interface $1 link state down && nv config apply -y; sleep 5; nv set interface $1 link state up && nv config apply -y" ;;',
    '    *) ${SSH} "${SW}" "configure terminal ; interface $1 ; shutdown" ; sleep 5 ; ${SSH} "${SW}" "configure terminal ; interface $1 ; no shutdown" ;;',
    '  esac',
    '}',
    'while [ "$(date +%s)" -lt "${END}" ]; do',
    '  for i in $(shuf -i 0-$(( ${#PORTS[@]} - 1 )) -n "${N}"); do',
    '    flap "${PORTS[$i]}" &',
    '  done',
    '  wait; sleep 30',
    'done > "${LOG_DIR}/link-flap-${SW}.log" 2>&1',
  ]);
}

export function perftestSh(m: TestKitModel): string {
  const x = m.isIb ? '' : ' -x 3';
  const gpuFlag = m.vendor === 'amd' ? ' --use_rocm=${k}' : m.vendor === 'nvidia' ? ' --use_cuda=${k}' : '';
  return j([
    '#!/usr/bin/env bash',
    '# 20-rdma: pairwise RDMA bandwidth per rail (perftest ib_write_bw) → logs/rdma/<client>-<nic>.txt',
    '# Pairs: inventory/hostfiles/bisection-pairs.txt (server client) — node i of one half of the leaves ↔ node i of the other half.',
    `# perftest options: -d -x --report_gbits -F -D -q -s -p${m.isIb ? ' (InfiniBand: no -x GID index)' : ' (RoCEv2 GID index 3, AMD guide)'}`,
    'source "$(dirname "${BASH_SOURCE[0]}")/../common.sh"',
    'OUT="${LOG_DIR}/rdma"; mkdir -p "${OUT}"',
    'DUR="${DUR:-30}"; QPS="${QPS:-1}"',
    `RAILS="\${RAILS:-${m.nicNames.length}}"`,
    `DEVPREFIX="\${DEVPREFIX:-${m.vendor === 'amd' ? 'rdma' : 'mlx5_'}}"`,
    'grep -v "^#" "${KIT_DIR}/inventory/hostfiles/bisection-pairs.txt" | sed "/^$/d" | while read -r srv cli; do',
    '  for k in $(seq 0 $(( RAILS - 1 ))); do',
    '    port=$(( 18500 + k ))',
    `    \${SSH} "\${srv}" "ib_write_bw -d \${DEVPREFIX}\${k}${x} -F --report_gbits -s 1048576 -D \${DUR} -q \${QPS} -p \${port}${gpuFlag}" > "\${OUT}/\${srv}-rail\${k}.srv" 2>&1 &`,
    '  done',
    '  sleep 2',
    '  for k in $(seq 0 $(( RAILS - 1 ))); do',
    '    port=$(( 18500 + k ))',
    `    \${SSH} "\${cli}" "ib_write_bw -d \${DEVPREFIX}\${k}${x} -F --report_gbits -s 1048576 -D \${DUR} -q \${QPS} -p \${port}${gpuFlag} \${srv}" > "\${OUT}/\${cli}-rail\${k}.txt" 2>&1 &`,
    '  done',
    '  wait',
    'done',
    '# Bidirectional variant (AMD floor 770 Gb/s per 400G NIC): add -b. Entropy sweep: QPS=4, QPS=16.',
  ]);
}

function ncclEnv(m: TestKitModel): string[] {
  const hca = m.vendor === 'amd' ? '${NCCL_IB_HCA:?set NCCL_IB_HCA to the backend RDMA devices, e.g. rdma0,...}' : `\${NCCL_IB_HCA:-${m.nicNames.map((_, i) => `mlx5_${i}`).join(',')}}`;
  return [
    `export NCCL_IB_HCA="${hca}"`,
    'export NCCL_SOCKET_IFNAME="${NCCL_SOCKET_IFNAME:-eth0}"',
    ...(m.isIb ? ['# InfiniBand: no NCCL_IB_GID_INDEX / NCCL_IB_TC'] : ['export NCCL_IB_GID_INDEX="${NCCL_IB_GID_INDEX:-3}"', '# NCCL_IB_TC 106 = DSCP 26 << 2 | ECT(0) (derived) — must match the switch lossless class', 'export NCCL_IB_TC="${NCCL_IB_TC:-106}"']),
    '# network-bound runs so the nominal busbw applies',
    'export NCCL_ALGO="${NCCL_ALGO:-Ring}" NCCL_NVLS_ENABLE=0 NCCL_COLLNET_ENABLE=0',
    ...((m.scaleUpDomain ?? 0) > m.gpusPerNode
      ? [
          `# NVLink domain (${m.scaleUpDomain} GPUs) spans several nodes: trays of one rack would talk over multi-node NVLink, so the run would not be`,
          '# network-bound. NCCL env docs: "NCCL_MNNVL_ENABLE (since 2.21) … 0: Disable MNNVL support".',
          'export NCCL_MNNVL_ENABLE=0',
        ]
      : []),
    'export NCCL_IB_QPS_PER_CONNECTION="${NCCL_IB_QPS_PER_CONNECTION:-1}" NCCL_CROSS_NIC="${NCCL_CROSS_NIC:-0}"',
    'export NCCL_DEBUG=INFO NCCL_DEBUG_SUBSYS=INIT,NET',
    `# per-plane runs are optional (default: aggregate over all rails); set NCCL_IB_HCA to one plane's devices to measure one plane`,
    `export NCCL_TESTS_SPLIT="MOD ${m.gpusPerNode}"`,
  ];
}

export function ncclBuildSh(m: TestKitModel): string {
  return j(m.vendor === 'amd'
    ? ['#!/usr/bin/env bash', '# _build: rccl-tests (ROCm/rccl-tests README) — run once on a build host', 'set -euo pipefail', 'git clone https://github.com/ROCm/rccl-tests.git && cd rccl-tests', 'make -j MPI=1 MPI_HOME="${MPI_HOME:?}" HIP_HOME="${ROCM_HOME:-/opt/rocm}" NCCL_HOME="${RCCL_HOME:?}"']
    : ['#!/usr/bin/env bash', '# _build: nccl-tests (NVIDIA/nccl-tests README) — run once on a build host', 'set -euo pipefail', 'git clone https://github.com/NVIDIA/nccl-tests.git && cd nccl-tests', 'make -j MPI=1 MPI_HOME="${MPI_HOME:?}" CUDA_HOME="${CUDA_HOME:-/usr/local/cuda}" NCCL_HOME="${NCCL_HOME:?}"']);
}

/** η measurement kit — mpirun form (Open MPI + UCX). */
export function etaMpirunSh(m: TestKitModel): string {
  return j([
    '#!/usr/bin/env bash',
    `# 30-collectives: η MEASUREMENT KIT (${m.tool}, mpirun). Two scopes with NCCL_TESTS_SPLIT="MOD ${m.gpusPerNode}" (network-only groups, nccl-tests README):`,
    '#   single-leaf  — nodes on one leaf: rings never leave the leaf (baseline, η_host)',
    `#   cross-spine  — one node per leaf / pod interleaved (${m.crossSpineGroups} leaf groups): every ring edge crosses the spine (η_fabric)`,
    `# η_bus = plateau busbw ÷ (NIC Gb/s ÷ 8) = ÷ ${m.nicGbps / 8} GB/s · η_fabric = η_bus(cross-spine) ÷ η_bus(single-leaf)`,
    '# Output: logs/collectives/<collective>_<scope>.log — first line "# AIDC-KIT eta …" tells the Network panel η calibration box that the run is',
    '# MOD-split (one GPU and one NIC per node per communicator → nominal busbw = NIC Gb/s ÷ 8). Paste the .log text there, or run eta_calibrate.py.',
    'source "$(dirname "${BASH_SOURCE[0]}")/../common.sh"',
    'OUT="${LOG_DIR}/collectives"; mkdir -p "${OUT}"',
    'TESTS="${TESTS:-${KIT_DIR}/nccl-tests/build}"',
    `GPN=${m.gpusPerNode}`,
    ...ncclEnv(m),
    'for scope in single-leaf cross-spine; do',
    '  HOSTS="${KIT_DIR}/inventory/hostfiles/${scope}.txt"',
    '  N=$(grep -cv "^#" "${HOSTS}" || true)',
    '  [ "${N}" -ge 2 ] || { log "${scope}: fewer than 2 hosts, skipped"; continue; }',
    '  for coll in all_reduce alltoall; do',
    `    echo "# AIDC-KIT eta scope=\${scope} collective=\${coll} split=MOD:\${GPN} nic_gbps=${m.nicGbps} nics_per_rank=1 nodes=\${N}" > "\${OUT}/\${coll}_\${scope}.log"`,
    '    mpirun -np $(( N * GPN )) -N "${GPN}" --hostfile "${HOSTS}" --bind-to numa \\',
    '      --mca pml ucx --mca btl ^openib -mca oob_tcp_if_exclude docker,lo -mca btl_tcp_if_exclude docker,lo \\',
    '      -x NCCL_IB_HCA -x NCCL_SOCKET_IFNAME -x NCCL_ALGO -x NCCL_NVLS_ENABLE -x NCCL_COLLNET_ENABLE \\',
    `      -x NCCL_IB_QPS_PER_CONNECTION -x NCCL_CROSS_NIC -x NCCL_DEBUG -x NCCL_DEBUG_SUBSYS -x NCCL_TESTS_SPLIT${(m.scaleUpDomain ?? 0) > m.gpusPerNode ? ' -x NCCL_MNNVL_ENABLE' : ''}${m.isIb ? '' : ' -x NCCL_IB_GID_INDEX -x NCCL_IB_TC'} \\`,
    '      "${TESTS}/${coll}_perf" -b 1M -e 16G -f 2 -g 1 -n 20 -w 5 2>&1 | tee -a "${OUT}/${coll}_${scope}.log"',
    '  done',
    'done',
    'python3 "${KIT_DIR}/30-collectives/eta_calibrate.py" "${OUT}/all_reduce_single-leaf.log" "${OUT}/all_reduce_cross-spine.log" --nic-gbps ' + String(m.nicGbps) + ' --out "${RESULTS_DIR}/eta.json" || true',
  ]);
}

/** η measurement kit — Slurm srun form (PMIx). */
export function etaSrunSh(m: TestKitModel): string {
  return j([
    '#!/usr/bin/env bash',
    `# 30-collectives: η MEASUREMENT KIT (${m.tool}, Slurm srun --mpi=pmix). Same scopes and outputs as eta_mpirun.sh.`,
    '# --label prefixes lines with "N: " (the parsers strip it). --mpi=pmix requires Slurm with PMIx; omit it if the site default works.',
    '# Leading underscore: not run by run_all.sh (use either the mpirun or the srun form).',
    'source "$(dirname "${BASH_SOURCE[0]}")/../common.sh"',
    'OUT="${LOG_DIR}/collectives"; mkdir -p "${OUT}"',
    'TESTS="${TESTS:-${KIT_DIR}/nccl-tests/build}"',
    `GPN=${m.gpusPerNode}`,
    ...ncclEnv(m),
    'for scope in single-leaf cross-spine; do',
    '  HOSTS="${KIT_DIR}/inventory/hostfiles/${scope}.txt"',
    '  N=$(grep -cv "^#" "${HOSTS}" || true)',
    '  [ "${N}" -ge 2 ] || { log "${scope}: fewer than 2 hosts, skipped"; continue; }',
    '  for coll in all_reduce alltoall; do',
    `    echo "# AIDC-KIT eta scope=\${scope} collective=\${coll} split=MOD:\${GPN} nic_gbps=${m.nicGbps} nics_per_rank=1 nodes=\${N}" > "\${OUT}/\${coll}_\${scope}.log"`,
    '    srun -N "${N}" --ntasks-per-node="${GPN}" --gpus-per-node="${GPN}" --mpi=pmix --label \\',
    '      --nodelist="$(grep -v "^#" "${HOSTS}" | paste -sd, -)" --export=ALL \\',
    '      "${TESTS}/${coll}_perf" -b 1M -e 16G -f 2 -g 1 -n 20 -w 5 2>&1 | tee -a "${OUT}/${coll}_${scope}.log"',
    '  done',
    'done',
  ]);
}

export function nodeDiagSh(m: TestKitModel): string {
  return j(m.vendor === 'amd'
    ? [
        '#!/usr/bin/env bash',
        '# 40-node: AMD health — AGFHC through the Cluster Validation Suite (CVS) + single-node RCCL → logs/node/',
        'source "$(dirname "${BASH_SOURCE[0]}")/../common.sh"',
        'OUT="${LOG_DIR}/node"; mkdir -p "${OUT}"',
        'CVS="${CVS_DIR:-/opt/cvs}"',
        '# CVS command (rocm.docs.amd.com/projects/cvs): cluster file and health config are site-specific',
        'cd "${CVS}" && pytest -vvv --log-file="${OUT}/agfhc.log" -s ./tests/health/agfhc_cvs.py --cluster_file input/cluster_file/cluster.json --config_file input/config_file/health/mi300_health_config.json --html="${OUT}/agfhc.html" --capture=tee-sys --self-contained-html || log "AGFHC CVS failed"',
        'for h in $(hosts_of all); do',
        '  ${SSH} "${h}" "${TESTS:-/opt/rccl-tests/build}/all_reduce_perf -b 8 -e 8G -f 2 -g 8" > "${OUT}/${h}-rccl-single-node.log" 2>&1 || true',
        'done',
      ]
    : [
        '#!/usr/bin/env bash',
        '# 40-node: NVIDIA DCGM diagnostics level 3 (< 35 min on 8-GPU systems, vendor claim) + single-node nccl-tests → logs/node/',
        'source "$(dirname "${BASH_SOURCE[0]}")/../common.sh"',
        'OUT="${LOG_DIR}/node"; mkdir -p "${OUT}"',
        'for h in $(hosts_of all); do',
        '  # DCGM: dcgmi diag -r 3 -j (JSON output)',
        '  ${SSH} "${h}" "dcgmi diag -r 3 -j" > "${OUT}/${h}-dcgm-r3.json" 2>&1 &',
        'done',
        'wait',
        'for h in $(hosts_of all); do',
        `  \${SSH} "\${h}" "\${TESTS:-/opt/nccl-tests/build}/all_reduce_perf -b 8 -e 8G -f 2 -g ${m.gpusPerNode}" > "\${OUT}/\${h}-nccl-single-node.log" 2>&1 || true`,
        'done',
      ]);
}

export function storageSh(): string {
  return j([
    '#!/usr/bin/env bash',
    '# 50-storage: fio (JSON output), IOR and mdtest from the client nodes → logs/storage/',
    'source "$(dirname "${BASH_SOURCE[0]}")/../common.sh"',
    'OUT="${LOG_DIR}/storage"; mkdir -p "${OUT}"',
    'MNT="${MNT:?set MNT to the parallel file system mount point}"',
    'NP="${NP:-64}"',
    '# fio: --output-format=json',
    'fio --output-format=json --directory="${MNT}" "${KIT_DIR}/50-storage/fio-seq.fio" > "${OUT}/fio-seq.json"',
    '# IOR: -t 1m -b 16m -s 16 -F -C -e (file per process, reorder tasks, fsync)',
    'mpirun -n "${NP}" --hostfile "${KIT_DIR}/inventory/hostfiles/all.txt" ior -t 1m -b 16m -s 16 -F -C -e -o "${MNT}/ior.dat" > "${OUT}/ior.txt" 2>&1',
    '# mdtest [A]: -n items -i iterations -u unique dir per task -d test dir',
    'mpirun -n "${NP}" --hostfile "${KIT_DIR}/inventory/hostfiles/all.txt" mdtest -n 100000 -i 3 -u -d "${MNT}/mdtest" > "${OUT}/mdtest.txt" 2>&1',
  ]);
}

export const FIO_JOB = j([
  '; 50-storage sequential write / read (fio job file; directory is passed on the command line)',
  '[global]',
  'ioengine=libaio',
  'direct=1',
  'bs=1m',
  'size=16g',
  'numjobs=8',
  'group_reporting=1',
  'runtime=120',
  'time_based=1',
  '',
  '[seq-write]',
  'rw=write',
  '',
  '[seq-read]',
  'stonewall',
  'rw=read',
]);

export function redfishSh(): string {
  return j([
    '#!/usr/bin/env bash',
    '# 60-thermal-power: poll every BMC (Redfish) every 10 s in the background → logs/thermal-power/<bmc>.jsonl',
    '# usage: BMC_USER=... BMC_PASS=... bash redfish_poll.sh   (stop with: pkill -f redfish_poll.py)',
    'source "$(dirname "${BASH_SOURCE[0]}")/../common.sh"',
    'OUT="${LOG_DIR}/thermal-power"; mkdir -p "${OUT}"',
    'BMCS="${KIT_DIR}/inventory/bmcs.txt"',
    '[ -s "${BMCS}" ] || { log "inventory/bmcs.txt is empty — add BMC addresses (ip-plan/oob.csv)"; exit 0; }',
    'grep -v "^#" "${BMCS}" | sed "/^$/d" | while read -r bmc; do',
    '  nohup python3 "${KIT_DIR}/60-thermal-power/redfish_poll.py" "${bmc}" "${BMC_USER:?}" "${BMC_PASS:?}" > "${OUT}/${bmc}.jsonl" 2> "${OUT}/${bmc}.err" &',
    'done',
  ]);
}
