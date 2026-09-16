// Backlog T3 (7): thermal state that belongs to an undo snapshot. Deleting a hall drops its in-memory thermal result and scenarios;
// `removeHall` records them under the project *before* the removal (undo puts them back) and a drop marker under the project *after*
// it (redo removes them again). Keys are the immutable project snapshots of the store's past / future stacks (WeakMap: no leaks).
import type { Project } from '@aidc/core';

export interface ThermalLike<S extends { id: string; options: { hallId?: string } }, R extends { options: { hallId?: string } }, M, H> {
  scenarios: S[];
  result: R | null;
  metrics: M | null;
  history: H[];
  status: string;
}

export interface HallThermalStash {
  hallId: string;
  scenarios: { id: string; options: { hallId?: string } }[];
  result: { options: { hallId?: string } } | null;
  metrics: unknown;
  history: unknown[];
  status: string;
}

export const hallThermalRestore = new WeakMap<Project, HallThermalStash>();
export const hallThermalDrop = new WeakMap<Project, string>();

/** Thermal state to show when the store moves to `project` (undo / redo). */
export function withHallThermal<T extends ThermalLike<{ id: string; options: { hallId?: string } }, { options: { hallId?: string } }, unknown, unknown>>(th: T, project: Project): T {
  const back = hallThermalRestore.get(project);
  if (back) {
    const ids = new Set(th.scenarios.map((sc) => sc.id));
    const scenarios = [...th.scenarios, ...back.scenarios.filter((sc) => !ids.has(sc.id))];
    const result = th.result ?? back.result;
    return { ...th, scenarios, ...(th.result || !back.result ? {} : { result, metrics: back.metrics, history: back.history, status: back.status } as unknown as Partial<T>) };
  }
  const drop = hallThermalDrop.get(project);
  if (drop) {
    const resultGone = th.result?.options.hallId === drop;
    return { ...th, scenarios: th.scenarios.filter((sc) => sc.options.hallId !== drop), ...(resultGone ? { result: null, metrics: null, history: [], status: 'idle' } as unknown as Partial<T> : {}) };
  }
  return th;
}
