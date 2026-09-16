// r4 stream A1: select the scene prims an emitter draws and key its geometry on their content hash, so a new HallPrims object with the
// same geometry (for example after an analysis refresh that moved nothing) does not rebuild GPU buffers.
import { useMemo } from 'react';
import { primsHash, type HallPrims, type Prim } from '@aidc/core';

export interface PrimSubset {
  prims: Prim[];
  /** content key: hall id + primsHash of the subset */
  key: string;
}

/** `filter` must be a stable (module-level) function. */
export function usePrimSubset(hp: HallPrims | null | undefined, filter: (p: Prim) => boolean): PrimSubset {
  return useMemo(() => {
    const prims = hp ? hp.prims.filter(filter) : [];
    return { prims, key: `${hp?.hallId ?? ''}|${primsHash(prims)}` };
  }, [hp, filter]);
}
