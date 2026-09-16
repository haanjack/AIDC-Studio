import type { Project } from '../model/types.ts';

/**
 * Intentional builtin catalog value changes that alter results of stored projects (stream B / P2).
 *
 * The web app shows a one-time notice per project when the project uses one of `catalogIds` (E renders the message from
 * `messageKey` with the before / after values). Nothing is written to stored projects; the catalog value itself changed.
 */
export interface CatalogDataChange {
  id: string;
  date: string;
  catalogIds: string[];
  fields: { path: string; before: number; after: number; unit: string }[];
  /** short English basis for logs / deliverables; UI text comes from i18n */
  basis: string;
  sourceUrl: string;
  messageKey: string;
}

export const CATALOG_DATA_CHANGES: readonly CatalogDataChange[] = [
  {
    id: 'xdu2300-datasheet-2026-09-15',
    date: '2026-09-15',
    catalogIds: ['vertiv-xdu2300'],
    fields: [
      { path: 'power.nameplateKW', before: 32, after: 47.8, unit: 'kW' },
      { path: 'power.peakKW', before: 32, after: 47.8, unit: 'kW' },
      { path: 'weightKg', before: 1569, after: 1793, unit: 'kg' },
    ],
    basis: 'Public vendor datasheet: nominal power 47.8 kW and wet mass 1,793 kg replace the earlier planning values (32 kW, 1,569 kg).',
    sourceUrl: 'https://www.vertiv.com/4a480e/globalassets/shared/vertiv-coolchipcdu-2300kw-_datasheet_global-english_sl-80607.pdf',
    messageKey: 'catalog.dataChange.xdu2300',
  },
];

/** Changes that affect a project: any placed equipment or the project's default CDU uses a changed catalog id. */
export function catalogDataChangesFor(project: Pick<Project, 'equipment' | 'cooling'>): CatalogDataChange[] {
  const used = new Set<string>(project.equipment.map((e) => e.catalogId));
  if (project.cooling?.cduCatalogId) used.add(project.cooling.cduCatalogId);
  return CATALOG_DATA_CHANGES.filter((c) => c.catalogIds.some((id) => used.has(id)));
}
