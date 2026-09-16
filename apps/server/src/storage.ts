import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createReferenceProject, findCatalogItem, upgradeProject, type Project } from '../../../packages/core/src/index.ts';

export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: string;
  halls: number;
  racks: number;
  gpus: number;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export function isValidId(id: string): boolean {
  return ID_RE.test(id) && !id.includes('..');
}

export function isProjectLike(v: unknown): v is Project {
  const p = v as Partial<Project> | null;
  return !!p && typeof p === 'object' && p.schemaVersion === 1 && Array.isArray(p.halls) && Array.isArray(p.equipment) && typeof p.name === 'string';
}

export function summarize(p: Project): ProjectSummary {
  let racks = 0;
  let gpus = 0;
  for (const e of p.equipment) {
    const item = findCatalogItem(e.catalogId);
    if (!item) continue;
    if (item.category.endsWith('-rack')) racks++;
    gpus += item.compute?.gpus ?? 0;
  }
  return { id: p.id, name: p.name, updatedAt: p.updatedAt, halls: p.halls.length, racks, gpus };
}

/** JSON-file project store (one file per project). */
export class ProjectStore {
  constructor(readonly dir: string) {}

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private file(id: string): string {
    if (!isValidId(id)) throw Object.assign(new Error(`invalid project id: ${id}`), { statusCode: 400 });
    return join(this.dir, `${id}.json`);
  }

  async list(): Promise<ProjectSummary[]> {
    const names = (await readdir(this.dir)).filter((n) => n.endsWith('.json'));
    const out: ProjectSummary[] = [];
    for (const n of names) {
      try {
        const p = JSON.parse(await readFile(join(this.dir, n), 'utf8'));
        // geometry-only reference-CFD projects written by older versions (purpose 'reference-cfd') are not part of the product surface
        if (isProjectLike(p) && p.purpose !== 'reference-cfd') out.push(summarize(p));
      } catch {
        // skip unreadable files
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<Project | null> {
    try {
      // stream A (P1): legacy ids / enums canonicalised and an inferred standards profile added (pure, idempotent)
      return upgradeProject(JSON.parse(await readFile(this.file(id), 'utf8')) as Project);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async exists(id: string): Promise<boolean> {
    return (await this.get(id)) !== null;
  }

  async put(project: Project): Promise<Project> {
    const target = this.file(project.id);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(project, null, 2), 'utf8');
    await rename(tmp, target);
    return project;
  }

  async delete(id: string): Promise<boolean> {
    if (!(await this.exists(id))) return false;
    await rm(this.file(id));
    return true;
  }

  async seedIfEmpty(): Promise<void> {
    if ((await this.list()).length > 0) return;
    const { project } = createReferenceProject();
    await this.put(project);
  }
}
