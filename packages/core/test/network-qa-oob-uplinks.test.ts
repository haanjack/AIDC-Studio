// QA backlog (network lens): OOB leaf uplinks must land on front-end switch ports that are actually free. On the generic RoCE
// reference the front-end spines' 64 downlinks were all taken by FE leaf uplinks, yet OOB uplinks were still split onto them
// (162 `SVC-SPN0n:?` cable ends). Schedules without that overflow must not change.
import { describe, expect, it } from 'vitest';
import { analyzeProject, buildCableSchedule, buildSwitchUnits, createNvidiaReferenceProject, FABRIC_SWITCH, summarizeCableSchedule, type FabricTech, type Project } from '../src/index.ts';

const withFabric = (p: Project, fabric: FabricTech): Project => ({ ...p, network: { ...p.network, scaleOut: { ...p.network.scaleOut, fabric, switchCatalogId: FABRIC_SWITCH[fabric] } } });

describe('OOB uplinks respect front-end spine capacity', () => {
  for (const fabric of ['roce-generic-800', 'roce-generic-400'] as const) {
    it(`${fabric} reference: every OOB uplink lands on a switch port (0 unresolved ends, 0 overflow)`, () => {
      const p = withFabric(createNvidiaReferenceProject().project, fabric);
      const a = analyzeProject(p);
      const rows = buildCableSchedule(p, a);
      const up = rows.filter((r) => r.fabricKey === 'oob' && r.tier === 'uplink');
      expect(up.length).toBeGreaterThan(0);
      expect(up.filter((r) => r.toPort.endsWith(':?') || r.fromPort.endsWith(':?'))).toEqual([]);
      const sum = summarizeCableSchedule(rows, buildSwitchUnits(p, a));
      expect(sum.unresolvedEnds).toBe(0);
      expect(sum.overflowPorts).toBe(0);
      const ends = new Set<string>();
      for (const r of rows) for (const e of [r.fromPort, r.toPort]) {
        expect(ends.has(e), e).toBe(false);
        ends.add(e);
      }
    });
  }

  it('Spectrum-X and InfiniBand references keep 0 unresolved ends', () => {
    for (const fabric of ['spectrumx-800', 'ib-xdr-800'] as const) {
      const p = withFabric(createNvidiaReferenceProject().project, fabric);
      expect(summarizeCableSchedule(buildCableSchedule(p, analyzeProject(p))).unresolvedEnds, fabric).toBe(0);
    }
  });
});
