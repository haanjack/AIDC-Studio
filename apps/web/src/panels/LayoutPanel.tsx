import { useEffect, useMemo, useRef, useState } from 'react';
import { applyHallLayout, autoSizeBaseOptions, autoSizeGridChoice, fabricSwitchFor, autoSizeHall, autoSizeLayoutOptions, CABLE_REACH_M, catalogItems, CORRIDOR_DEFAULTS, defaultServicesZone, defaultSpinePlacement, findCatalogItem, acceleratorRacksPerDu, builtinCatalog, coolantLimitCheck, libraryWithRegistration, mixedComputeFamilies, slotMissingEquipmentIds, templateSlotKey, type AutoSizeResult, registerPlatformInProject, registrablePlatforms, slotPlatformOptions, unregisteredPlatforms, withTemplateSlot, type AutoSizeReport, type AutoSizeRequest, type CatalogItem, type ComputeSlot, generateHallLayout, hallShortfall, LAYOUT_TEMPLATES, layoutOptionsFromProject, normalizePlacement, notchKeepouts, podSizing, resolveLayoutTemplate, rowEndWalls, SERVICES_ZONE_MODES, spinePlacementsForGrowth, type Containment, type EquipmentInstance, type FitCandidate, type FitOptions, type GridChoice, type GrowthPattern, type HallLayoutOptions, type LayoutPolicy, type PodTemplate, type Project, type ServicesZoneMode, type SizingSuggestion, type SpinePlacement, type Wall, layoutReachRunM, defaultWaveStart, DEFAULT_TEMPLATE_ID, effectiveStandardsProfile, platformEligibility, slotCandidates } from '@aidc/core';
import { GenerationReportCard, replaceProject } from '../ui/IssueFixes.tsx';
import { libraryCache, projectGrowth, useApp } from '../store/appStore.ts';
import { PLACEABLE, catalogOptions, equipmentKW, findFreeSpot, hallEquipment } from '../app/derived.ts';
import { fmt1, fmtInt, fmtMoney, fmtPower } from '../app/format.ts';
import { DataTable, NumberField, Section, Select, SelectField, Seg, SourceBadge, Stat, TextField, Toggle } from '../ui/controls.tsx';
import { Icon } from '../ui/icons.tsx';
import { Term } from '../ui/Term.tsx';
import { useIssueText, useT, type TParams } from '../i18n/index.ts';
import type { FitWorkerRequest, FitWorkerResponse } from '../workers/fit.worker.ts';
// stream E (P5, proposal §6.1): hall standards override, template picker filtered by the profile, slot eligibility with reasons
import { HallStandardsSection } from '../ui/StandardsProfile.tsx';
import { templatePickerEntries, templateRackForm } from '../app/standardsUi.ts';
import type { LayoutWorkerRequest, LayoutWorkerResponse } from '../workers/layout.worker.ts';

/**
 * Layout panel (stream S1 v2 → T1 v2 2차): template-driven generator with two modes —
 *   auto-size: fixed, grow-only compatibility, or bidirectional right-sizing; orientation + pod columns are chosen by
 *     `chooseLayoutGrid` (minimum hall area within 2:1, ties → rows along the long side) unless the user sets them; with auto-size
 *     off the hall is fixed and rows follow its long side unless the air-throw / wall-length check fails (the reason is shown);
 *   fit-to-space: the fit solver (layout/fit.ts, in a worker) enumerates template × orientation × grid × spine placement ×
 *     CRAH strategy inside the existing hall and shows the top 3 with a 3D preview (ties prefer rows along the long side).
 * Services live in a zone (end band / centre band / support HAC / separate room, DECISIONS-v2-2 F3b); unused positions are
 * reserve / expansion positions. Spine placement itself is a network setting (Network panel); growth only sets its default.
 */

type Mode = 'grow' | 'fit';
type HallSizingMode = 'fixed' | 'grow' | 'right-size';
type Tr = (key: string, params?: TParams) => string;

interface GenForm {
  templateId: string;
  template: PodTemplate;
  pods: number;
  storageRacks: number;
  cpuRacks: number;
  mgmtRacks: number;
  crahCatalogId: string;
  marginM: number;
  podsPerWave: number;
  waveStart: number;
  /** fixed envelope, grow-only compatibility mode, or bidirectional right-sizing */
  hallSizing: HallSizingMode;
  /** autosize v2 2차: raise the hall IT / liquid / air budgets (and utility feeds) to the generated design; off = budgets are binding */
  fitBudgets: boolean;
  services: boolean;
  orientation: 'x' | 'y';
  columns: number;
  /** orientation + pod columns chosen by chooseLayoutGrid until the user sets either */
  autoGrid: boolean;
  crahStrategy: LayoutPolicy['crahStrategy'];
  crahWalls: Wall[];
  /** CRAH walls follow the row orientation (the row-end walls) */
  autoWalls: boolean;
  servicesZone: ServicesZoneMode | 'auto';
  // fit-to-space
  objective: LayoutPolicy['objective'];
  allTemplates: boolean;
  /** fit: every registered compute platform of each template (DECISIONS-v2-2 §E5) */
  allPlatforms: boolean;
  allPlacements: boolean;
  limitPods: boolean;
}

const PLACEMENTS: SpinePlacement[] = ['central-end', 'central-center', 'distributed', 'separate-room'];
const GROWTHS: GrowthPattern[] = ['phased', 'single-build'];
const STRATEGIES: LayoutPolicy['crahStrategy'][] = ['perimeter', 'in-row', 'per-pod', 'gallery-fan-wall'];
const OBJECTIVES: LayoutPolicy['objective'][] = ['max-gpus', 'min-cable', 'tokens-per-mw'];

function initialForm(project: Project, hallId: string): GenForm {
  const hall = project.halls.find((h) => h.id === hallId) ?? project.halls[0];
  const o = layoutOptionsFromProject(project, hall);
  const hasServices = !!o.services && (o.services.storageRacks + o.services.cpuRacks + o.services.mgmtRacks > 0 || hallEquipment(project, hallId).length === 0);
  const orientation = o.orientation ?? 'x';
  const walls = (o.crahWalls as Wall[] | undefined) ?? rowEndWalls(orientation);
  return {
    templateId: o.templateId ?? DEFAULT_TEMPLATE_ID,
    template: o.template,
    pods: o.pods || 4,
    storageRacks: o.services?.storageRacks ?? 0,
    cpuRacks: o.services?.cpuRacks ?? 0,
    mgmtRacks: o.services?.mgmtRacks ?? 0,
    crahCatalogId: o.crahCatalogId,
    marginM: o.marginM,
    podsPerWave: o.podsPerWave,
    // fix v2 2차 (QA): the hall's own first wave (or after the other halls' waves) — a fixed 1 merged two halls' phases into wave-01
    waveStart: defaultWaveStart(project, hall.id),
    hallSizing: 'right-size',
    fitBudgets: true,
    services: hasServices || !!o.services,
    orientation,
    columns: o.columns ?? 1,
    autoGrid: hall.layoutPolicy?.autoOrientation ?? (hall.layoutPolicy?.grid?.columns ?? 1) <= 1,
    crahStrategy: o.crahStrategy ?? 'perimeter',
    crahWalls: walls,
    autoWalls: [...walls].sort().join('') === [...rowEndWalls(orientation)].sort().join(''),
    servicesZone: hall.layoutPolicy?.servicesZone ?? 'auto',
    objective: hall.layoutPolicy?.objective ?? 'max-gpus',
    allTemplates: false,
    allPlatforms: false,
    allPlacements: false,
    limitPods: false,
  };
}

const zoneOf = (project: Project, f: GenForm): ServicesZoneMode => (f.servicesZone === 'auto' ? defaultServicesZone(project.growth) : f.servicesZone);

/**
 * autosize v2 2차: the form as a core request. Preview and "Generate" both go through layout/autosize.ts, so the preview shows what the
 * generator places (engine-verified CDU / CRAH / network counts, the project fabric switch when other halls use it, hall budgets).
 */
function requestOf(f: GenForm): AutoSizeRequest {
  return {
    templateId: f.templateId,
    template: f.template,
    pods: f.pods,
    services: f.services ? { spineRacks: 'auto', storageRacks: f.storageRacks, cpuRacks: f.cpuRacks, mgmtRacks: f.mgmtRacks } : undefined,
    crahCatalogId: f.crahCatalogId,
    marginM: f.marginM,
    podsPerWave: f.podsPerWave,
    waveStart: f.waveStart,
    autoSize: f.hallSizing !== 'fixed',
    rightSize: f.hallSizing === 'right-size',
    crahStrategy: f.crahStrategy,
    servicesZone: f.servicesZone,
    grid: { auto: f.autoGrid, orientation: f.orientation, columns: f.columns },
    crahWalls: f.autoWalls ? 'auto' : f.crahWalls,
    budgets: f.fitBudgets ? 'fit' : 'hold',
  };
}

/** Options without the grid (template, services, cooling, zone) — the grid chooser probes these. */
function baseOptions(project: Project, hall: Project['halls'][number], f: GenForm): HallLayoutOptions {
  return autoSizeBaseOptions(project, hall, requestOf(f));
}

/** Orientation + columns for the grow generator (auto → chooseLayoutGrid on the current hall; fixed when auto-size is off). */
function gridChoiceFor(project: Project, hall: Project['halls'][number], f: GenForm): GridChoice | null {
  return autoSizeGridChoice(project, hall, requestOf(f));
}

function buildOptions(project: Project, hall: Project['halls'][number], f: GenForm, choice: GridChoice | null = gridChoiceFor(project, hall, f)): HallLayoutOptions {
  return autoSizeLayoutOptions(project, hall, requestOf(f), choice);
}
void baseOptions;

function applyCandidate(d: Project, hallId: string, c: FitCandidate, f: GenForm) {
  applyHallLayout(d, hallId, c.layout, c.options, { waveStart: f.waveStart, policy: { ...c.policy, ...(f.servicesZone !== 'auto' ? { servicesZone: f.servicesZone } : {}) } });
  d.cooling.cduCatalogId = c.options.template.cduCatalogId;
  d.cooling.crahCatalogId = c.options.crahCatalogId;
  d.network.scaleOut.switchCatalogId = c.options.template.scaleOutSwitchCatalogId;
  d.network.scaleOut.oversubscription = c.options.template.oversubscription;
  d.network.scaleOut.spinePlacement = c.spinePlacement;
  d.network.scaleOut.separateRoom = c.spinePlacement === 'separate-room';
}

/** One-line reason + warnings for a grid choice. */
function gridReasonLine(t: Tr, c: GridChoice): string {
  // the free-wall count selects the English singular (`_one`) form; other reasons carry no count
  const head = t(`layout.grid.reason.${c.reason}`, c.reason === 'auto-free-wall' && c.params.freeWalls !== undefined ? { ...c.params, n: c.params.freeWalls } : c.params);
  const warns = c.warnings.map((w) => (w.code === 'throw' && Number(w.params.liquidDominant) === 1 ? t('layout.grid.warn.throwLiquid', w.params) : t(`layout.grid.warn.${w.code}`, w.params)));
  return [head, ...warns].join(' · ');
}

interface FitState {
  status: 'idle' | 'running' | 'done' | 'error';
  done: number;
  total: number;
  candidates: FitCandidate[];
  ms: number;
  error?: string;
}

export function LayoutPanel() {
  const t = useT();
  const issueText = useIssueText();
  const project = useApp((s) => s.project);
  const hallId = useApp((s) => s.hallId);
  const update = useApp((s) => s.update);
  const selection = useApp((s) => s.selection);
  const select = useApp((s) => s.select);
  const setSelection = useApp((s) => s.setSelection);
  const editMode = useApp((s) => s.editMode);
  const setEditMode = useApp((s) => s.setEditMode);
  const viewerApi = useApp((s) => s.viewerApi);
  const notify = useApp((s) => s.notify);
  const setGrowth = useApp((s) => s.setGrowth);
  const previewProject = useApp((s) => s.previewProject);
  const setPreviewProject = useApp((s) => s.setPreviewProject);
  const sizingSuggestion = useApp((s) => s.sizingSuggestion);
  const setSizingSuggestion = useApp((s) => s.setSizingSuggestion);
  const libraryVersion = useApp((s) => s.libraryVersion);
  const pendingSetup = useApp((s) => s.pendingGeneratorSetup);
  const setPendingSetup = useApp((s) => s.setPendingGeneratorSetup);
  const pendingAddId = useApp((s) => s.pendingAddCatalogId);
  const setPendingAddId = useApp((s) => s.setPendingAddCatalogId);
  const hall = project.halls.find((h) => h.id === hallId) ?? project.halls[0];

  const [mode, setMode] = useState<Mode>('grow');
  const [form, setForm] = useState<GenForm>(() => initialForm(project, hall.id));
  const [genReport, setGenReport] = useState<{ hallId: string; report: AutoSizeReport } | null>(null);
  const [formHall, setFormHall] = useState(hall.id);
  if (formHall !== hall.id) {
    setFormHall(hall.id);
    setForm(initialForm(project, hall.id));
  }
  const [filter, setFilter] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [addId, setAddId] = useState('nvidia-gb300-nvl72');
  const [fit, setFit] = useState<FitState>({ status: 'idle', done: 0, total: 0, candidates: [], ms: 0 });
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [showAllTemplates, setShowAllTemplates] = useState(false);
  const worker = useRef<Worker | null>(null);
  const jobId = useRef(0);
  // stream T4 (#8): hall generation runs in workers/layout.worker.ts (progress = elapsed time, cancel = terminate)
  const setPage = useApp((s) => s.setPage);
  const [gen, setGen] = useState<{ ms: number } | null>(null);
  const genJob = useRef(0);
  const genStop = useRef<(() => void) | null>(null);
  useEffect(() => () => genStop.current?.(), []);
  useEffect(() => () => {
    worker.current?.terminate();
    worker.current = null;
  }, []);
  // leave the preview when the panel unmounts or the hall changes
  useEffect(() => () => setPreviewProject(null), [setPreviewProject]);
  useEffect(() => {
    setPreviewProject(null);
    setPreviewId(null);
  }, [hall.id, setPreviewProject]);

  const placementLabel = (p: SpinePlacement) => t(`layout.placement.${p}`);
  const zoneLabel = (z: ServicesZoneMode) => t(`layout.zone.${z}`);

  // T5 → T1: preselect the saved item in 장비 추가 / Add equipment
  useEffect(() => {
    if (!pendingAddId) return;
    if (findCatalogItem(pendingAddId)) setAddId(pendingAddId);
    setPendingAddId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAddId]);

  // DECISIONS-v2-2 §E: compute slots list only the platforms registered to the template (built-in list ∪ project.templateRegistry ∪
  // library / project catalog items tagged meta.templateSlots); `libraryVersion` re-renders after a library registration
  const saveLibrary = useApp((s) => s.saveLibrary);
  const regCtx = { project };
  const [regSlot, setRegSlot] = useState('primary');
  const [regItem, setRegItem] = useState('');
  const [regTarget, setRegTarget] = useState<'project' | 'library'>('project');
  void libraryVersion;
  const slotLabel = (slot: ComputeSlot) => {
    const key = `layout.slot.${slot.id}`;
    const v = t(key);
    return v === key ? slot.label : v;
  };
  const registerTo = async (templateId: string, slotId: string, catalogId: string, target: 'project' | 'library') => {
    const item = findCatalogItem(catalogId);
    const tpl = LAYOUT_TEMPLATES.find((x) => x.id === templateId);
    const slot = tpl?.computeSlots.find((x) => x.id === slotId);
    if (!item || !tpl || !slot) return;
    if (target === 'library' && item.origin !== 'project') {
      // stream T4 (#4): a built-in item gets a registration-only library record (meta.registrationOnly + templateSlots), merged into
      // the current built-in item by resolveCatalog, so later seed updates stay visible; existing full copies are migrated when equal
      await saveLibrary(libraryWithRegistration(libraryCache, item, builtinCatalog().items, templateSlotKey(templateId, slotId)));
    } else if (target === 'library') {
      // a project-layer item shadows any library copy, so the registration travels with the project item
      if (!update((d) => { const ext = d.catalogExtensions?.find((x) => x.id === catalogId); if (ext) ext.meta = withTemplateSlot(ext, templateId, slotId).meta; })) return;
    } else if (!update((d) => { registerPlatformInProject(d, templateId, slotId, catalogId); })) return;
    notify(t('layout.reg.toast', { name: item.name, template: tpl.name, slot: slotLabel(slot), layer: t(target === 'project' ? 'layout.reg.targetProject' : 'layout.reg.targetLibrary') }), 'ok');
  };

  const sizing = useMemo(() => { try { return podSizing(form.template); } catch { return null; } }, [form.template]);
  const setT = (patch: Partial<PodTemplate>) => setForm((f) => ({ ...f, template: { ...f.template, ...patch } }));
  const setContainment = (containment: PodTemplate['containment']) => setForm((f) => ({
    ...f,
    template: { ...f.template, containment, ...(containment !== 'none' && (f.template.rowsPerPod ?? 2) === 1 ? { rowsPerPod: 2 as const } : {}) },
  }));
  /** accelerator slot: '' = off; racks per DU default from the slot rule */
  const setAcc = (slot: ComputeSlot, catalogId: string, racks?: number) =>
    setForm((f) => {
      const list = f.template.accelerators ?? [];
      const cur = list.find((a) => a.slotId === slot.id);
      const others = list.filter((a) => a.slotId !== slot.id);
      const racksPerDu = racks ?? cur?.racksPerDu ?? acceleratorRacksPerDu(slot, f.template.racksPerRow * (f.template.rowsPerPod ?? 2));
      return { ...f, template: { ...f.template, accelerators: catalogId ? [...others, { slotId: slot.id, catalogId, racksPerDu }] : others } };
    });
  const growth = projectGrowth(project);
  const spineNow = normalizePlacement(project.network.scaleOut.spinePlacement);
  const gridChoice = useMemo(() => (mode === 'grow' ? gridChoiceFor(project, hall, form) : null), [mode, project, hall, form]);
  // QA autosize v2 2차: the generator keeps the project's fabric switch when other halls hold compute racks — show that switch in the form
  const fabricSw = useMemo(() => (mode === 'grow' ? fabricSwitchFor(project, hall.id, form.template.scaleOutSwitchCatalogId) : null), [mode, project, hall.id, form.template.scaleOutSwitchCatalogId]);
  const effOrientation = gridChoice?.orientation ?? form.orientation;
  const effColumns = gridChoice?.columns ?? form.columns;
  const previewOnly = useMemo(() => {
    if (mode !== 'grow') return null;
    try {
      const opts = buildOptions(project, hall, form, gridChoice);
      const l = generateHallLayout(opts);
      const lost = hall.keepouts.length ? notchKeepouts(l, hall, (opts.corridors ?? CORRIDOR_DEFAULTS).egressM) : 0;
      const podDepth = l.grid.rows * l.grid.podPitchM;
      const podWidth = l.grid.columns * l.grid.rowLengthM + (l.grid.columns - 1) * (opts.corridors ?? CORRIDOR_DEFAULTS).transportM;
      const placement = opts.spinePlacement ?? 'central-end';
      const zoneMode = l.zone?.mode ?? opts.servicesZone;
      // polish v2 2차: the chooser's measured worst front-end run (leaf rack → FE / storage aggregation incl. band-end racks, analysis route factor)
      const reach = layoutReachRunM(l, { routeFactor: project.network.cabling.routeFactor, slackPerEndM: project.network.cabling.slackPerEndM, trayHeightM: hall.trayHeight });
      const reachRunM = reach.runM;
      void placement; void zoneMode;
      return { required: { width: l.requiredWidth, depth: l.requiredDepth }, shortfall: hallShortfall(hall, l), crah: l.crah, central: l.central, grid: l.grid, issues: l.issues, lost, podDepth, podWidth, reachRunM, reachFrom: reach.from, reachTo: reach.to, zone: l.zone };
    } catch {
      return null;
    }
  }, [mode, project, hall, form, gridChoice]);
  const zoneNow = project.servicesZones?.find((z) => z.hallId === hall.id);

  const eq = hallEquipment(project, hall.id);
  const rows = eq.filter((e) => {
    const it = findCatalogItem(e.catalogId);
    if (filter !== 'all' && it?.category !== filter) return false;
    if (query && !`${e.tag} ${it?.name ?? ''}`.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  });
  const cats = [...new Set(eq.map((e) => findCatalogItem(e.catalogId)?.category ?? 'other'))];
  const selected = eq.filter((e) => selection.includes(e.id));
  const single = selected.length === 1 ? selected[0] : null;
  const singleItem = single ? findCatalogItem(single.catalogId) : undefined;

  const mutateSelected = (fn: (e: EquipmentInstance) => void) => update((d) => { d.equipment.filter((e) => selection.includes(e.id)).forEach(fn); });

  const pickTemplate = (id: string) => {
    const tpl = resolveLayoutTemplate(id, { project });
    if (!tpl) return;
    setForm((f) => ({
      ...f,
      templateId: id,
      template: { ...tpl.pod, cduCatalogId: f.template.cduCatalogId, cduRedundancy: f.template.cduRedundancy, oversubscription: f.template.oversubscription },
      crahStrategy: tpl.defaults.crahStrategy,
      servicesZone: tpl.defaults.servicesZone ?? f.servicesZone,
    }));
  };

  const changeGrowth = (g: GrowthPattern) => {
    setGrowth(g); // the store applies the default spine placement (DECISIONS-v2 #1)
    notify(t('layout.toast.growth', { growth: t(`layout.growth.${g}`), placement: placementLabel(defaultSpinePlacement(g)), zone: zoneLabel(defaultServicesZone(g)) }), 'info');
  };

  /** Workload panel sizing box → prefill DU count, racks per row and the GPU rack; the pill below shows what was taken. */
  const appliedSuggestion = useRef<string | null>(null);
  const applySuggestion = (sg: SizingSuggestion) => {
    setMode('grow');
    setForm((f) => {
      const rowsPerPod = f.template.rowsPerPod ?? 2;
      const rack = findCatalogItem(sg.gpuRackCatalogId);
      return {
        ...f,
        pods: Math.max(1, sg.pods),
        template: {
          ...f.template,
          gpuRackCatalogId: rack ? sg.gpuRackCatalogId : f.template.gpuRackCatalogId,
          racksPerRow: Math.max(1, Math.round(sg.racksPerPod / rowsPerPod)),
        },
      };
    });
    appliedSuggestion.current = sg.createdAt;
  };
  useEffect(() => {
    if (sizingSuggestion && appliedSuggestion.current !== sizingSuggestion.createdAt) applySuggestion(sizingSuggestion);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sizingSuggestion?.createdAt]);
  // Compute platform & design units → Layout: consume one coherent setup after the generic workload suggestion, so the chosen
  // template's own row shape and explicit services-zone default remain authoritative.
  useEffect(() => {
    if (!pendingSetup) return;
    const tpl = resolveLayoutTemplate(pendingSetup.templateId, { project });
    const rack = findCatalogItem(pendingSetup.platformId);
    if (tpl && rack?.category === 'gpu-rack') {
      setMode('grow');
      setForm((f) => ({
        ...f,
        templateId: tpl.id,
        pods: Math.max(1, pendingSetup.pods),
        template: {
          ...tpl.pod,
          gpuRackCatalogId: rack.id,
          cduCatalogId: f.template.cduCatalogId,
          cduRedundancy: f.template.cduRedundancy,
          oversubscription: f.template.oversubscription,
        },
        crahStrategy: tpl.defaults.crahStrategy,
        servicesZone: tpl.defaults.servicesZone ?? f.servicesZone,
      }));
      if (sizingSuggestion) appliedSuggestion.current = sizingSuggestion.createdAt;
    }
    setPendingSetup(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSetup]);

  const finishGenerate = (r: AutoSizeResult, probe: Project, h: { id: string; name: string; width: number; depth: number }, pods: number) => {
    if (!r.ok) {
      const parts = [r.shortfall.width > 0 ? t('layout.toast.widthShort', { v: fmt1(r.shortfall.width) }) : null, r.shortfall.depth > 0 ? t('layout.toast.depthShort', { v: fmt1(r.shortfall.depth) }) : null].filter(Boolean).join(', ');
      notify(t('layout.toast.noFit', { hall: h.name, w: fmt1(h.width), d: fmt1(h.depth), rw: fmt1(r.required.width), rd: fmt1(r.required.depth), parts }), 'error');
      return;
    }
    if (!update((d) => replaceProject(d, probe))) return; // fix v2 2차: read-only — beforeEdit already showed its toast
    setSelection([]);
    setPreviewProject(null);
    setGenReport({ hallId: h.id, report: r.report });
    notify(t('layout.toast.generated', { hall: h.name, pods }) + (r.lost ? t('layout.toast.generatedLost', { n: r.lost }) : ''), 'ok');
  };
  const cancelGenerate = () => {
    genStop.current?.();
    notify(t('layout.gen.cancelled'), 'info');
  };
  const generate = () => {
    // autosize v2 2차: one engine-verified generation on a copy, then the copy becomes the project (one undo step)
    const probe = structuredClone(project);
    const req = requestOf(form);
    const h = { id: hall.id, name: hall.name, width: hall.width, depth: hall.depth };
    const pods = form.pods;
    if (typeof Worker === 'undefined') { finishGenerate(autoSizeHall(probe, hall.id, req), probe, h, pods); return; }
    genStop.current?.();
    const started = project;
    const w = new Worker(new URL('../workers/layout.worker.ts', import.meta.url), { type: 'module' });
    const id = ++genJob.current;
    const t0 = performance.now();
    const tick = window.setInterval(() => setGen({ ms: performance.now() - t0 }), 250);
    const stop = () => {
      window.clearInterval(tick);
      w.terminate();
      if (genJob.current === id) { genJob.current++; setGen(null); genStop.current = null; }
    };
    genStop.current = stop;
    setGen({ ms: 0 });
    w.onmessage = (ev: MessageEvent<LayoutWorkerResponse>) => {
      const m = ev.data;
      if (m.id !== id || genJob.current !== id) return;
      if (m.type === 'progress') { setGen({ ms: m.ms }); return; }
      stop();
      if (m.type === 'error') { notify(t('layout.gen.failed', { msg: m.message }), 'error'); return; }
      // the result replaces the whole project: never apply it over edits made while the worker ran
      if (useApp.getState().project !== started) { notify(t('layout.gen.stale', { hall: h.name }), 'error'); return; }
      finishGenerate(m.result, m.project, h, pods);
    };
    w.onerror = (e) => { if (genJob.current !== id) return; stop(); notify(t('layout.gen.failed', { msg: e.message }), 'error'); };
    w.postMessage({ type: 'run', id, project: probe, hallId: hall.id, req, library: { items: libraryCache.items, cables: libraryCache.cables } } satisfies LayoutWorkerRequest);
  };

  const runFit = () => {
    if (!worker.current) worker.current = new Worker(new URL('../workers/fit.worker.ts', import.meta.url), { type: 'module' });
    const id = ++jobId.current;
    const w = worker.current;
    w.onmessage = (ev: MessageEvent<FitWorkerResponse>) => {
      const m = ev.data;
      if (m.id !== jobId.current) return;
      if (m.type === 'progress') setFit((s) => ({ ...s, done: m.done, total: m.total }));
      else if (m.type === 'done') setFit({ status: 'done', done: m.candidates.length, total: m.candidates.length, candidates: m.candidates, ms: m.ms });
      else setFit((s) => ({ ...s, status: 'error', error: m.message }));
    };
    w.onerror = (e) => setFit((s) => ({ ...s, status: 'error', error: e.message }));
    const policy: LayoutPolicy = { templateId: form.templateId, orientation: form.orientation, corridors: hall.layoutPolicy?.corridors ?? CORRIDOR_DEFAULTS, crahStrategy: form.crahStrategy, crahWalls: form.autoWalls ? undefined : form.crahWalls, objective: form.objective, servicesZone: zoneOf(project, form) };
    const opts: Omit<FitOptions, 'onProgress'> = {
      policy,
      top: 3,
      templateIds: form.allTemplates ? 'all' : [form.templateId],
      platforms: form.allPlatforms ? 'all' : 'selected',
      spinePlacements: form.allPlacements ? spinePlacementsForGrowth(growth) : spinePlacementsForGrowth(growth).slice(0, 2),
      template: { gpuRackCatalogId: form.template.gpuRackCatalogId, accelerators: form.template.accelerators, cduCatalogId: form.template.cduCatalogId, cduRedundancy: form.template.cduRedundancy, scaleOutSwitchCatalogId: form.template.scaleOutSwitchCatalogId, oversubscription: form.template.oversubscription, racksPerRow: form.templateId === 'custom' ? form.template.racksPerRow : undefined },
      services: form.services ? { spineRacks: 'auto', storageRacks: form.storageRacks, cpuRacks: form.cpuRacks, mgmtRacks: form.mgmtRacks } : undefined,
      crahCatalogId: form.crahCatalogId,
      crahRedundancy: project.cooling.crahRedundancy,
      marginM: form.marginM,
      podsPerWave: form.podsPerWave,
      maxPods: form.limitPods ? form.pods : undefined,
    };
    // drop undefined template overrides so the template's own values apply
    opts.template = Object.fromEntries(Object.entries(opts.template ?? {}).filter(([, v]) => v !== undefined)) as Partial<PodTemplate>;
    setFit({ status: 'running', done: 0, total: 0, candidates: [], ms: 0 });
    setPreviewProject(null);
    setPreviewId(null);
    // the fit worker regenerates with the hall's zone: pass the chosen zone through the hall policy of the posted project
    const posted = form.servicesZone === 'auto' ? project : { ...project, halls: project.halls.map((h) => (h.id === hall.id ? { ...h, layoutPolicy: { ...(h.layoutPolicy ?? policy), servicesZone: form.servicesZone as ServicesZoneMode } } : h)) };
    w.postMessage({ type: 'run', id, project: posted, hallId: hall.id, opts, library: { items: libraryCache.items, cables: libraryCache.cables } } satisfies FitWorkerRequest);
  };

  const preview = (c: FitCandidate) => {
    if (previewId === c.id) {
      setPreviewProject(null);
      setPreviewId(null);
      return;
    }
    const scratch = structuredClone(project);
    applyCandidate(scratch, hall.id, c, form);
    setPreviewProject(scratch);
    setPreviewId(c.id);
  };

  const applyFit = (c: FitCandidate) => {
    if (!update((d) => applyCandidate(d, hall.id, c, form))) return;
    setPreviewProject(null);
    setPreviewId(null);
    setSelection([]);
    notify(t('layout.toast.fitApplied', { hall: hall.name, pods: c.pods, c: c.columns, r: c.rows, placement: placementLabel(c.spinePlacement).split(' (')[0] }), 'ok');
  };

  const tplInfo = resolveLayoutTemplate(form.templateId, regCtx);
  const hallUnreg = unregisteredPlatforms(project, hall.id);
  const unregWarn = (slot: ComputeSlot, catalogId: string) => (
    <div className="small" style={{ margin: '-4px 0 8px', padding: '4px 8px', borderLeft: '3px solid var(--warning)', display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }} data-unregistered-platform={catalogId}>
      <span>{t('layout.reg.unregistered', { name: findCatalogItem(catalogId)?.name ?? catalogId, template: tplInfo?.name ?? form.templateId, slot: slotLabel(slot) })}</span>
      <button className="btn sm" onClick={() => void registerTo(form.templateId, slot.id, catalogId, 'project')}>{t('layout.reg.fix')}</button>
    </div>
  );
  // stream T4 (#1): liquid platform whose coolant supply limit is below the project TCS supply (exact numbers + link to the setting)
  const coolWarn = (catalogId: string | undefined) => {
    const item = catalogId ? findCatalogItem(catalogId) : undefined;
    const c = coolantLimitCheck(item, project.cooling.tcsSupplyC);
    if (!c || !item) return null;
    return (
      <div className="small" style={{ margin: '-4px 0 8px', padding: '4px 8px', borderLeft: '3px solid var(--warning)', display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }} data-coolant-limit={item.id}>
        <span>{t('layout.slot.coolantWarn', { name: item.name, limit: String(c.limitC), tcs: String(c.tcsSupplyC), excess: String(c.excessC) })}</span>
        <button className="btn ghost sm" onClick={() => setPage('cooling')}>{t('layout.slot.coolantLink')}</button>
      </div>
    );
  };
  const hallReg = hallUnreg.filter((u) => !u.slotMissing);
  const hallMissing = hallUnreg.filter((u) => u.slotMissing);
  const hallMissingIds = hallMissing.flatMap((u) => slotMissingEquipmentIds(project, u));
  const wallsValue = form.autoWalls ? 'auto' : form.crahWalls.join('');
  const zoneMode = zoneOf(project, form);

  return (
    <div>
      <Section title={t('layout.gen.title')} actions={<Seg value={mode} options={[{ value: 'grow', label: t('layout.mode.grow') }, { value: 'fit', label: t('layout.mode.fit') }]} onChange={setMode} />}>
        <div className="card">
          <div className="row wrap" style={{ justifyContent: 'space-between', gap: 8, marginBottom: 8, padding: '7px 9px', background: 'var(--surface-2)', borderRadius: 6 }} data-architecture-handoff>
            <span className="small">{t('layout.architecture.link', { platform: findCatalogItem(form.template.gpuRackCatalogId)?.name ?? form.template.gpuRackCatalogId, template: tplInfo?.name ?? form.templateId })}</span>
            <button className="btn ghost sm" onClick={() => setPage('architecture')}><Icon name="architecture" size={13} />{t('layout.architecture.edit')}</button>
          </div>
          {sizingSuggestion && (
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }} data-sizing-suggestion>
              <span className="pill good" title={t('layout.suggestion.tooltip')}>
                <span className="dot" />
                {t('layout.suggestion.pill', { workload: sizingSuggestion.workloadName, gpus: fmtInt(sizingSuggestion.gpus), pods: sizingSuggestion.pods, racks: sizingSuggestion.racksPerPod, rack: findCatalogItem(sizingSuggestion.gpuRackCatalogId)?.name ?? sizingSuggestion.gpuRackCatalogId, mw: fmt1(sizingSuggestion.itMW), area: fmtInt(sizingSuggestion.areaM2) })}
              </span>
              <span className="row" style={{ gap: 4 }}>
                <button className="btn ghost sm" onClick={() => applySuggestion(sizingSuggestion)}>{t('layout.suggestion.refill')}</button>
                <button className="btn ghost sm" onClick={() => setSizingSuggestion(null)}>{t('layout.suggestion.clear')}</button>
              </span>
            </div>
          )}
          {hallReg.length > 0 && (
            <div className="row small" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8, padding: '4px 8px', borderLeft: '3px solid var(--warning)' }} data-hall-unregistered>
              <span>{t('layout.reg.hallWarn', { template: LAYOUT_TEMPLATES.find((x) => x.id === hallReg[0].templateId)?.name ?? hallReg[0].templateId, names: hallReg.map((u) => findCatalogItem(u.catalogId)?.name ?? u.catalogId).join(', ') })}</span>
              <button className="btn ghost sm" onClick={() => { if (update((d) => { for (const u of hallReg) registerPlatformInProject(d, u.templateId, u.slotId, u.catalogId); })) notify(t('layout.reg.toast', { name: hallReg.map((u) => findCatalogItem(u.catalogId)?.name ?? u.catalogId).join(', '), template: resolveLayoutTemplate(hallReg[0].templateId)?.name ?? hallReg[0].templateId, slot: hallReg.map((u) => { const sl = resolveLayoutTemplate(u.templateId)?.computeSlots.find((x) => x.id === u.slotId); return sl ? slotLabel(sl) : u.slotId; }).join(', '), layer: t('layout.reg.targetProject') }), 'ok'); }}>{t('layout.reg.fix')}</button>
            </div>
          )}
          {hallMissing.length > 0 && (
            <div className="row small" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8, padding: '4px 8px', borderLeft: '3px solid var(--warning)' }} data-hall-slot-missing>
              <span>{t('layout.reg.slotMissing', { names: [...new Set(hallMissing.map((u) => findCatalogItem(u.catalogId)?.name ?? u.catalogId))].join(', '), slot: [...new Set(hallMissing.map((u) => u.slotId))].join(', '), template: LAYOUT_TEMPLATES.find((x) => x.id === hallMissing[0].templateId)?.name ?? hallMissing[0].templateId })}</span>
              <button className="btn ghost sm" disabled={!hallMissingIds.length} onClick={() => { const ids = new Set(hallMissingIds); if (update((d) => { d.equipment = d.equipment.filter((e) => !ids.has(e.id)); })) { setSelection([]); notify(t('layout.reg.removed', { n: ids.size, hall: hall.name }), 'ok'); } }}>{t('layout.reg.removeRacks', { n: hallMissingIds.length })}</button>
            </div>
          )}
          <div className="fields-2">
            <div>
              <HallStandardsSection hall={hall} />
              {(() => {
                const hallStd = effectiveStandardsProfile(project, hall);
                const picker = templatePickerEntries(hallStd?.rackForm, form.templateId, showAllTemplates);
                const cur = picker.entries.find((e) => e.template.id === form.templateId);
                const curForm = cur ? templateRackForm(cur.template) : undefined;
                return (
                  <div data-template-picker data-template-hidden={picker.hidden}>
                    <SelectField label={t('layout.field.template')} value={form.templateId}
                      options={picker.entries.map(({ template: x, matches }) => {
                        const base = `${t(`layout.group.${x.group}`)} · ${x.name}`;
                        const f = templateRackForm(x);
                        return { value: x.id, label: matches || !f ? base : t('standards.ui.tpl.otherForm', { name: base, form: t(`standards.rackForm.${f}`) }) };
                      })}
                      onChange={pickTemplate}
                      hint={hallStd ? `${t('standards.ui.tpl.filtered', { profile: t(`standards.rackForm.${hallStd.rackForm}`) })}${picker.hidden ? ` ${t('standards.ui.tpl.hidden', { n: picker.hidden })}` : ''}` : undefined} />
                    {hallStd && (picker.hidden > 0 || showAllTemplates) && <div style={{ margin: '-4px 0 8px' }}><Toggle label={t('standards.ui.tpl.showAll')} checked={showAllTemplates} onChange={setShowAllTemplates} /></div>}
                    {hallStd && cur && !cur.matches && curForm && (
                      <div className="small" style={{ margin: '-4px 0 8px', padding: '4px 8px', borderLeft: '3px solid var(--warning)' }} data-template-mismatch>
                        {t('standards.ui.tpl.mismatch', { form: t(`standards.rackForm.${curForm}`), current: t(`standards.rackForm.${hallStd.rackForm}`) })}
                      </div>
                    )}
                  </div>
                );
              })()}
              <div data-compute-slots>
                {(tplInfo?.computeSlots ?? []).map((slot) => {
                  const opts = slotPlatformOptions(form.templateId, slot.id, regCtx);
                  if (slot.role === 'primary') {
                    const cur = form.template.gpuRackCatalogId;
                    const ok = opts.some((o) => o.value === cur);
                    return (
                      <div key={slot.id} data-slot={slot.id}>
                        <SelectField label={slotLabel(slot)} value={ok ? cur : ''} options={ok ? opts : [{ value: '', label: t('layout.slot.unregisteredPlaceholder') }, ...opts]} onChange={(v) => { if (v) setT({ gpuRackCatalogId: v }); }} hint={t('layout.field.gpuPlatformHint', { n: opts.length, total: catalogItems().filter((c) => c.category === 'gpu-rack').length })} />
                        {!ok && unregWarn(slot, cur)}
                        {coolWarn(cur)}
                        <SlotEligibilityList templateId={form.templateId} slotId={slot.id} currentId={cur} hallId={hall.id} />
                      </div>
                    );
                  }
                  const acc = form.template.accelerators?.find((a) => a.slotId === slot.id);
                  const ok = !acc || opts.some((o) => o.value === acc.catalogId);
                  return (
                    <div key={slot.id} data-slot={slot.id}>
                      <SelectField label={slotLabel(slot)} value={acc ? (ok ? acc.catalogId : '__unregistered') : ''} options={[{ value: '', label: t('layout.slot.none') }, ...(ok ? [] : [{ value: '__unregistered', label: t('layout.slot.unregisteredPlaceholder') }]), ...opts]} onChange={(v) => { if (v !== '__unregistered') setAcc(slot, v); }} hint={t('layout.slot.hint', { n: opts.length })} />
                      {acc && <NumberField label={t('layout.slot.racksPerDu')} value={acc.racksPerDu} min={0} step={1} onChange={(v) => setAcc(slot, acc.catalogId, Math.max(0, Math.round(v)))} hint={t('layout.slot.estimate')} />}
                      {acc && !ok && unregWarn(slot, acc.catalogId)}
                      {acc && coolWarn(acc.catalogId)}
                    </div>
                  );
                })}
                <details style={{ margin: '2px 0 10px' }} data-register-platform>
                  <summary style={{ cursor: 'pointer' }} className="small">{t('layout.reg.title')}</summary>
                  {(() => {
                    const slots = tplInfo?.computeSlots ?? [];
                    const slotId = slots.some((x) => x.id === regSlot) ? regSlot : (slots[0]?.id ?? 'primary');
                    const cands: CatalogItem[] = registrablePlatforms(form.templateId, slotId, regCtx);
                    const itemId = cands.some((c) => c.id === regItem) ? regItem : (cands[0]?.id ?? '');
                    return (
                      <div style={{ paddingTop: 6 }}>
                        <SelectField label={t('layout.reg.slot')} value={slotId} options={slots.map((x) => ({ value: x.id, label: slotLabel(x) }))} onChange={setRegSlot} />
                        {cands.length ? <SelectField label={t('layout.reg.item')} value={itemId} options={cands.map((c) => ({ value: c.id, label: c.name }))} onChange={setRegItem} /> : <div className="small muted">{t('layout.reg.none')}</div>}
                        <div className="field"><label>{t('layout.reg.target')}</label><Seg value={regTarget} options={[{ value: 'project' as const, label: t('layout.reg.targetProject') }, { value: 'library' as const, label: t('layout.reg.targetLibrary') }]} onChange={setRegTarget} /></div>
                        <button className="btn sm" disabled={!itemId} onClick={() => void registerTo(form.templateId, slotId, itemId, regTarget)}>{t('layout.reg.btn')}</button>
                      </div>
                    );
                  })()}
                </details>
              </div>
              {mode === 'grow' && <NumberField label={<Term id="du">{t('layout.field.pods')}</Term>} value={form.pods} min={1} max={400} onChange={(v) => setForm({ ...form, pods: Math.round(v) })} />}
              {mode === 'fit' && (
                <div className="field"><label>{t('layout.field.podCap')}</label><div className="row"><Toggle label={form.limitPods ? t('layout.field.podCapOn', { n: form.pods }) : t('layout.field.podCapOff')} checked={form.limitPods} onChange={(v) => setForm({ ...form, limitPods: v })} />{form.limitPods && <input type="number" min={1} value={form.pods} style={{ width: 70 }} onChange={(e) => setForm({ ...form, pods: Math.max(1, Math.round(Number(e.target.value))) })} />}</div></div>
              )}
              <NumberField label={t('layout.field.racksPerRow')} value={form.template.racksPerRow} min={1} step={1} onChange={(v) => setT({ racksPerRow: Math.max(1, Math.round(v)) })} hint={tplInfo ? t('layout.field.racksPerRowHint', { n: tplInfo.pod.maxRacksPerRow ?? 40 }) : undefined} />
              <NumberField label={t('layout.field.innerAisle')} unit="m" step={0.01} value={form.template.innerAisleM} onChange={(v) => setT({ innerAisleM: v })} />
              <NumberField label={t('layout.field.outerAisle')} unit="m" step={0.01} value={form.template.outerAisleM} onChange={(v) => setT({ outerAisleM: v })} />
              <SelectField label={<Term id="hac">{t('layout.field.containment')}</Term>} value={form.template.containment} options={(['hot-aisle', 'cold-aisle', 'none'] as const).map((v) => ({ value: v, label: t(`layout.containment.${v}`) }))} onChange={setContainment} hint={t('layout.field.containmentHint')} />
              {form.templateId === 'custom' && (
                <>
                  <SelectField label={t('layout.field.rowsPerPod')} value={String(form.template.rowsPerPod ?? 2)} options={[{ value: '2', label: t('layout.rowsPerPod.2') }, { value: '1', label: t('layout.rowsPerPod.1') }]} onChange={(v) => setForm((f) => ({ ...f, template: { ...f.template, rowsPerPod: v === '1' ? 1 : 2, ...(v === '1' ? { containment: 'none' as const } : {}) } }))} />
                  <SelectField label={t('layout.field.networkPlacement')} value={form.template.networkPlacement ?? 'row-end'} options={(['row-end', 'row-center'] as const).map((v) => ({ value: v, label: t(`layout.networkPlacement.${v}`) }))} onChange={(v) => setT({ networkPlacement: v })} />
                  <SelectField label={t('layout.field.cduPlacement')} value={form.template.cduPlacement ?? 'row-start'} options={(['row-start', 'row-ends', 'ends+center'] as const).map((v) => ({ value: v, label: t(`layout.cduPlacement.${v}`) }))} onChange={(v) => setT({ cduPlacement: v })} />
                </>
              )}
            </div>
            <div>
              <SelectField label={<Term id="growth">{t('layout.field.growth')}</Term>} value={growth} options={GROWTHS.map((g) => ({ value: g, label: t(`layout.growth.${g}`) }))} onChange={changeGrowth} hint={<span><Term id="spine-placement">{t('layout.field.spinePlacement')}</Term>: {placementLabel(spineNow)} {t('layout.field.spineNetworkPanel')}</span>} />
              <SelectField
                label={t('layout.field.servicesZone')}
                value={form.servicesZone}
                options={[{ value: 'auto' as const, label: t('layout.zone.auto', { mode: zoneLabel(defaultServicesZone(project.growth)) }) }, ...SERVICES_ZONE_MODES.map((z) => ({ value: z, label: zoneLabel(z) }))]}
                onChange={(v) => setForm({ ...form, servicesZone: v })}
                hint={t('layout.zone.hint')}
              />
              <SelectField
                label={t('layout.field.orientation')}
                value={form.autoGrid ? 'auto' : form.orientation}
                options={[{ value: 'auto', label: t('layout.orientation.auto') }, { value: 'x', label: t('layout.orientation.x') }, { value: 'y', label: t('layout.orientation.y') }]}
                onChange={(v) => setForm(v === 'auto' ? { ...form, autoGrid: true } : { ...form, autoGrid: false, orientation: v as 'x' | 'y', columns: effColumns })}
              />
              {mode === 'grow' && (
                <NumberField label={form.autoGrid ? t('layout.field.columnsAuto') : t('layout.field.columns')} value={effColumns} min={1} max={8}
                  onChange={(v) => setForm({ ...form, columns: Math.max(1, Math.round(v)), orientation: effOrientation, autoGrid: false })}
                  hint={form.autoGrid ? <a href="#" onClick={(e) => { e.preventDefault(); setForm({ ...form, autoGrid: false, orientation: effOrientation, columns: effColumns }); }}>{t('layout.field.manual')}</a> : <a href="#" onClick={(e) => { e.preventDefault(); setForm({ ...form, autoGrid: true }); }}>{t('layout.field.auto')}</a>} />
              )}
              {mode === 'grow' && gridChoice && (
                <p className="hint" style={{ margin: '-2px 0 6px' }} title={t('layout.grid.sources')} data-grid-reason={gridChoice.reason}>
                  {gridReasonLine(t, gridChoice)}
                </p>
              )}
              <SelectField label={t('layout.field.crahStrategy')} value={form.crahStrategy} options={STRATEGIES.map((s) => ({ value: s, label: t(`layout.strategy.${s}`) }))} onChange={(v) => setForm({ ...form, crahStrategy: v })} />
              {/* QA autosize v2 2차: the four wall buttons overflowed the narrow form column (EN "All 4" past the card edge) — let them wrap */}
              <style>{'[data-crah-walls] .seg { display: flex; flex-wrap: wrap; max-width: 100%; } [data-crah-walls] .seg button { flex: 1 1 auto; white-space: nowrap; }'}</style>
              <div className="field" data-crah-walls><label>{t('layout.field.crahWalls')}</label><Seg value={wallsValue} options={[{ value: 'auto', label: `${t('layout.walls.auto')} (${rowEndWalls(effOrientation).join('+')})` }, { value: 'WE', label: 'W+E' }, { value: 'NS', label: 'N+S' }, { value: 'WENS', label: t('layout.walls.all') }]} onChange={(v) => setForm(v === 'auto' ? { ...form, autoWalls: true } : { ...form, autoWalls: false, crahWalls: v.split('') as Wall[] })} /></div>
              <SelectField label={t('layout.field.cdu')} value={form.template.cduCatalogId} options={catalogOptions(['cdu'])} onChange={(v) => setT({ cduCatalogId: v })} />
              <SelectField label={t('layout.field.crah')} value={form.crahCatalogId} options={catalogOptions(['crah'])} onChange={(v) => setForm({ ...form, crahCatalogId: v })} />
              <div style={{ display: 'contents' }} data-scaleout-switch={fabricSw?.switchCatalogId ?? form.template.scaleOutSwitchCatalogId} data-switch-inherited={fabricSw?.kept ? '1' : '0'}>
                <SelectField label={t('layout.field.scaleOutSwitch')} value={fabricSw?.kept ? fabricSw.switchCatalogId : form.template.scaleOutSwitchCatalogId} options={catalogOptions(['switch'])} onChange={(v) => setT({ scaleOutSwitchCatalogId: v })}
                  hint={fabricSw?.kept ? <span data-switch-hint style={{ wordBreak: 'keep-all', overflowWrap: 'anywhere' }}>{t('autosize.form.switchInherited', { halls: fabricSw.halls.map((id) => project.halls.find((h) => h.id === id)?.name ?? id).join(', ') })}</span> : undefined} />
              </div>
              <NumberField label={<Term id="oversubscription">{t('layout.field.oversubscription')}</Term>} step={0.5} min={1} value={form.template.oversubscription} onChange={(v) => setT({ oversubscription: v })} unit=": 1" />
              <NumberField label={t('layout.field.podsPerWave')} min={1} value={form.podsPerWave} onChange={(v) => setForm({ ...form, podsPerWave: Math.round(v) })} />
              <NumberField label={t('layout.field.waveStart')} min={1} value={form.waveStart} onChange={(v) => setForm({ ...form, waveStart: Math.round(v) })} />
              <NumberField label={t('layout.field.margin')} unit="m" step={0.1} value={form.marginM} onChange={(v) => setForm({ ...form, marginM: v })} />
            </div>
          </div>
          <div className="row wrap" style={{ marginTop: 8, gap: 14 }}>
            <Toggle label={t('layout.toggle.services')} checked={form.services} onChange={(v) => setForm({ ...form, services: v })} />
            {mode === 'grow' && (
              <div className="field" style={{ minWidth: 280, margin: 0 }} data-hall-sizing>
                <label>{t('layout.field.hallSizing')}</label>
                <Seg value={form.hallSizing} options={([
                  ['fixed', 'layout.hallSizing.fixed'],
                  ['grow', 'layout.hallSizing.grow'],
                  ['right-size', 'layout.hallSizing.rightSize'],
                ] as [HallSizingMode, string][]).map(([value, key]) => ({ value, label: t(key) }))} onChange={(hallSizing) => setForm({ ...form, hallSizing })} />
                <span className="hint">{t(`layout.hallSizing.${form.hallSizing === 'right-size' ? 'rightSize' : form.hallSizing}Hint`)}</span>
              </div>
            )}
            {mode === 'grow' && <span title={t('autosize.budgets.hint')} data-fit-budgets><Toggle label={t('autosize.budgets.toggle')} checked={form.fitBudgets} onChange={(v) => setForm({ ...form, fitBudgets: v })} /></span>}
            {mode === 'fit' && <Toggle label={t('layout.toggle.allTemplates')} checked={form.allTemplates} onChange={(v) => setForm({ ...form, allTemplates: v })} />}
            {mode === 'fit' && <Toggle label={t('layout.toggle.allPlatforms')} checked={form.allPlatforms} onChange={(v) => setForm({ ...form, allPlatforms: v })} />}
            {mode === 'fit' && <Toggle label={t('layout.toggle.allPlacements')} checked={form.allPlacements} onChange={(v) => setForm({ ...form, allPlacements: v })} />}
          </div>
          {form.services && (
            <div className="grid-3" style={{ marginTop: 6 }}>
              <NumberField label={t('layout.services.storage')} value={form.storageRacks} min={0} onChange={(v) => setForm({ ...form, storageRacks: Math.round(v) })} />
              <NumberField label={t('layout.services.cpu')} value={form.cpuRacks} min={0} onChange={(v) => setForm({ ...form, cpuRacks: Math.round(v) })} />
              <NumberField label={t('layout.services.mgmt')} value={form.mgmtRacks} min={0} onChange={(v) => setForm({ ...form, mgmtRacks: Math.round(v) })} />
            </div>
          )}
          {tplInfo && <p className="hint" style={{ marginTop: 8 }}><SourceBadge source={tplInfo.source} /> {tplInfo.description}</p>}
          {sizing && (
            <p className="hint" style={{ marginTop: 4 }}>
              {t('layout.sizing.line', { racks: sizing.racks, cdus: sizing.cdus, liquid: fmtPower(sizing.liquidKW), leaves: sizing.leaves, net: sizing.netRacks, row: fmt1(sizing.rowLength), depth: fmt1(sizing.podDepth) })}
            </p>
          )}
          {zoneNow && (
            <p className="hint" style={{ marginTop: 4 }} data-zone-current={zoneNow.mode}>
              {t('layout.zone.current', { mode: zoneLabel(zoneNow.mode), rows: zoneNow.rows, positions: zoneNow.positionsPerRow, racks: zoneNow.racks, reserve: zoneNow.reservePositions })}
              {zoneNow.interHallCoreRacks ? t('layout.zone.currentIhc', { n: zoneNow.interHallCoreRacks }) : ''}
            </p>
          )}

          {mode === 'grow' && (
            <>
              {previewOnly && (
                <p className="hint" style={{ marginTop: 4 }} data-layout-preview>
                  {t('layout.preview.required', { w: fmt1(previewOnly.required.width), d: fmt1(previewOnly.required.depth), cw: fmt1(hall.width), cd: fmt1(hall.depth) })}
                  {previewOnly.shortfall.width > 0 || previewOnly.shortfall.depth > 0 ? <span style={{ color: 'var(--danger, #e57373)' }}>{t('layout.preview.short', { w: fmt1(previewOnly.shortfall.width), d: fmt1(previewOnly.shortfall.depth) })}</span> : t('layout.preview.fits')}) · {t('layout.preview.grid', { c: previewOnly.grid.columns, r: previewOnly.grid.rows })}{form.autoGrid ? t('layout.preview.autoGrid') : ''} · {t('layout.preview.central', { core: previewOnly.central.networkCoreRacks, svc: previewOnly.central.servicesRacks, rows: previewOnly.central.rows })} · {t('layout.preview.crah', { placed: previewOnly.crah.placed, required: previewOnly.crah.required, walls: previewOnly.crah.walls.join('/') || '—' })}
                  {previewOnly.zone && (
                    <span data-zone-preview={previewOnly.zone.mode}> · {t('layout.preview.zone', { mode: zoneLabel(previewOnly.zone.mode), rows: previewOnly.zone.rows, positions: previewOnly.zone.positionsPerRow, racks: previewOnly.zone.racks, reserve: previewOnly.zone.reservePositions })}{previewOnly.zone.interHallCoreRacks ? t('layout.preview.ihc', { n: previewOnly.zone.interHallCoreRacks }) : ''}</span>
                  )}
                  {previewOnly.lost > 0 && <span style={{ color: 'var(--warn, #e0a030)' }}> · {t('layout.preview.lost', { n: previewOnly.lost })}</span>}
                  {previewOnly.reachRunM > CABLE_REACH_M.value && <span style={{ color: 'var(--warn, #e0a030)' }} data-reach-warning> · {t('layout.preview.reachRun', { run: fmt1(previewOnly.reachRunM), reach: CABLE_REACH_M.value, from: previewOnly.reachFrom ?? '', to: previewOnly.reachTo ?? '' })}</span>}
                  {previewOnly.issues.map((i) => <span key={i.id} style={{ color: i.severity === 'error' ? 'var(--danger, #e57373)' : 'var(--warn, #e0a030)' }}> · {issueText.msg(i)}</span>)}
                </p>
              )}
              <div className="row" style={{ marginTop: 8 }}>
                {gen ? (
                  <span className="row" style={{ gap: 6, alignItems: 'center' }} data-generate-running>
                    <button className="btn primary" disabled><Icon name="refresh" size={14} />{t('layout.gen.running', { hall: hall.name, s: (gen.ms / 1000).toFixed(1) })}</button>
                    <button className="btn sm" onClick={cancelGenerate} data-generate-cancel>{t('layout.gen.cancel')}</button>
                  </span>
                ) : (
                  <button className="btn primary" onClick={generate} data-generate-layout><Icon name="refresh" size={14} />{t('layout.btn.generate', { hall: hall.name })}</button>
                )}
                <span className="hint">{t('layout.btn.generateHint', { hall: hall.name, sizing: t(`layout.hallSizing.${form.hallSizing === 'right-size' ? 'rightSize' : form.hallSizing}`) })}</span>
              </div>
              {genReport && genReport.hallId === hall.id && <GenerationReportCard report={genReport.report} hallId={hall.id} />}
              {zoneMode === 'support-hac' && (form.template.rowsPerPod ?? 2) !== 2 && <p className="hint" style={{ color: 'var(--warn, #e0a030)' }}>{t('layout.zone.support-hac')}: {t('layout.zone.hint')}</p>}
            </>
          )}

          {mode === 'fit' && (
            <>
              <div className="row wrap" style={{ marginTop: 8, gap: 10 }}>
                <div style={{ width: 220 }}><SelectField label={t('layout.fit.objective')} value={form.objective} options={OBJECTIVES.map((o) => ({ value: o, label: t(`layout.objective.${o}`) }))} onChange={(v) => setForm({ ...form, objective: v })} /></div>
                <button className="btn primary" disabled={fit.status === 'running'} onClick={runFit}><Icon name="refresh" size={14} />{fit.status === 'running' ? t('layout.fit.running', { done: fit.done, total: fit.total || '?' }) : t('layout.fit.run')}</button>
                <span className="hint">{t('layout.fit.hint', { w: fmt1(hall.width), d: fmt1(hall.depth), k: hall.keepouts.length, it: fmtPower(hall.itPowerBudgetKW), liq: fmtPower(hall.liquidCoolingBudgetKW), air: fmtPower(hall.airCoolingBudgetKW) })}</span>
              </div>
              {fit.status === 'error' && <p className="hint" style={{ color: 'var(--danger, #e57373)' }}>{t('layout.fit.error', { msg: fit.error ?? '' })}</p>}
              {fit.status === 'done' && fit.candidates.length === 0 && <p className="hint">{t('layout.fit.none')}</p>}
              {fit.candidates.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <DataTable
                    columns={[
                      { key: 'rank', header: '#', render: (c: FitCandidate) => String(fit.candidates.indexOf(c) + 1) },
                      { key: 'tpl', header: t('layout.fit.col.tpl'), render: (c) => <span>{c.templateId} · {findCatalogItem(c.platformId)?.name ?? c.platformId} · {c.orientation.toUpperCase()}{c.rowsAlongLongSide ? ` (${t('layout.fit.longSide')})` : ''} · {c.columns}×{c.rows}{c.crahStrategy !== 'perimeter' ? ` · ${c.crahStrategy}` : ''}</span> },
                      { key: 'spine', header: t('layout.fit.col.spine'), render: (c) => placementLabel(c.spinePlacement).split(' (')[0] },
                      { key: 'pods', header: t('layout.fit.col.pods'), num: true, render: (c) => String(c.pods), sortValue: (c) => c.pods },
                      { key: 'gpus', header: t('layout.fit.col.gpus'), num: true, render: (c) => fmtInt(c.gpus), sortValue: (c) => c.gpus },
                      { key: 'compute', header: t('layout.fit.col.compute'), num: true, render: (c) => <span title={t('layout.fit.computeTip', { family: c.computeFamily ?? '—' })}>{fmtInt(c.computeTflops ?? 0)}</span>, sortValue: (c) => c.computeTflops ?? 0 },
                      { key: 'mw', header: t('layout.fit.col.mw'), num: true, render: (c) => (c.itKW / 1000).toFixed(1), sortValue: (c) => c.itKW },
                      { key: 'cable', header: t('layout.fit.col.cable'), num: true, render: (c) => fmtMoney(c.cableUSD, project.pricing), sortValue: (c) => c.cableUSD },
                      { key: 'tray', header: t('layout.fit.col.tray'), num: true, render: (c) => t('layout.fit.trayCell', { n: fmtInt(c.trayPeakCables), mm2: fmtInt(c.trayPeakMm2) }), sortValue: (c) => c.trayPeakCables },
                      { key: 'lost', header: t('layout.fit.col.lost'), num: true, render: (c) => String(c.lostPositions) },
                      { key: 'lim', header: t('layout.fit.col.lim'), render: (c) => t(`layout.limit.${c.limitedBy}`) },
                      { key: 'err', header: t('layout.fit.col.err'), num: true, render: (c) => (c.errors ? <span style={{ color: 'var(--danger, #e57373)' }}>{c.errors}</span> : '0') },
                      { key: 'act', header: '', render: (c) => <span className="row" style={{ gap: 4 }}><button className={`btn sm ${previewId === c.id ? 'active' : ''}`} onClick={() => preview(c)}><Icon name="camera" size={12} />{t('layout.fit.preview')}</button><button className="btn sm primary" onClick={() => applyFit(c)}>{t('layout.fit.apply')}</button></span> },
                    ]}
                    rows={fit.candidates}
                    rowKey={(c) => c.id}
                  />
                  <p className="hint" style={{ marginTop: 4 }}>
                    {t('layout.fit.footer', { n: fit.candidates.length, ms: fmtInt(fit.ms), objective: t(`layout.objective.${form.objective}`) })}
                    {previewProject && t('layout.fit.previewing')}
                    {form.objective === 'max-gpus' && mixedComputeFamilies(fit.candidates) && <span data-fit-mixed-note>{t('layout.fit.mixedNote')}</span>}
                  </p>
                  {fit.candidates.some((c) => c.notes.length) && (
                    <ul className="hint" style={{ margin: '4px 0 0 16px' }}>
                      {fit.candidates.flatMap((c, i) => c.notes.map((n, j) => <li key={`${i}-${j}`}>#{i + 1}: {n}</li>))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </Section>

      <Section title={t('layout.add.title')}>
        <div className="row">
          <div className="grow"><Select value={addId} options={catalogItems().filter((c) => PLACEABLE.includes(c.category)).map((c) => ({ value: c.id, label: `${t(`layout.cat.${c.category}`)} · ${c.name}` }))} onChange={setAddId} /></div>
          <button className="btn" onClick={() => {
            const item = findCatalogItem(addId);
            if (!item) return;
            const pos = findFreeSpot(project, hall.id, item, 0);
            if (!pos) return notify(t('layout.toast.noFreeSpot'), 'error');
            const id = `eq-${Date.now().toString(36)}`;
            const tag = `${item.model.replace(/\s+/g, '').slice(0, 8).toUpperCase()}-${eq.filter((e) => e.catalogId === item.id).length + 1}`;
            update((d) => { d.equipment.push({ id, catalogId: item.id, hallId: hall.id, tag, position: pos, rotationDeg: 0, blanking: true, waveId: d.schedule.waves[0]?.id }); });
            select(id);
            setEditMode(true);
          }}><Icon name="plus" size={14} />{t('layout.add.button')}</button>
        </div>
      </Section>

      {selected.length > 0 && (
        <Section title={single ? t('layout.sel.titleOne', { tag: single.tag }) : t('layout.sel.titleMany', { n: selected.length })} actions={<button className="btn ghost sm" onClick={() => select(null)}>{t('layout.sel.clear')}</button>}>
          <div className="card">
            {single && singleItem ? (
              <>
                <div className="row" style={{ marginBottom: 6 }}>
                  <strong>{singleItem.name}</strong>
                  <SourceBadge source={singleItem.source} />
                  <span className="grow" />
                  <button className="btn ghost sm" onClick={() => viewerApi?.focusEquipment(single.id)}><Icon name="camera" size={13} />{t('layout.sel.focus')}</button>
                </div>
                <div className="hint" style={{ marginBottom: 6 }}>{singleItem.description}</div>
                <div className="fields-2">
                  <div>
                    <TextField label={t('layout.sel.tag')} value={single.tag} onChange={(v) => mutateSelected((e) => { e.tag = v; })} />
                    <SelectField label={t('layout.sel.model')} value={single.catalogId} options={catalogOptions([singleItem.category])} onChange={(v) => mutateSelected((e) => { e.catalogId = v; })} />
                    <NumberField label="X" unit="m" step={hall.tileSize / 2} digits={3} value={single.position.x} onChange={(v) => mutateSelected((e) => { e.position.x = v; })} />
                    <NumberField label="Y" unit="m" step={hall.tileSize / 2} digits={3} value={single.position.y} onChange={(v) => mutateSelected((e) => { e.position.y = v; })} />
                  </div>
                  <div>
                    <div className="field"><label>{t('layout.sel.direction')}</label><Seg value={single.rotationDeg} options={[0, 90, 180, 270].map((r) => ({ value: r as 0 | 90 | 180 | 270, label: `${r}°` }))} onChange={(v) => mutateSelected((e) => { e.rotationDeg = v; })} /></div>
                    <SelectField label={t('layout.sel.wave')} value={single.waveId ?? ''} options={[{ value: '', label: '—' }, ...project.schedule.waves.map((w) => ({ value: w.id, label: w.name }))]} onChange={(v) => mutateSelected((e) => { e.waveId = v || undefined; })} />
                    <NumberField label={t('layout.sel.load')} step={0.05} min={0} max={1.2} value={single.loadFactor ?? 1} onChange={(v) => mutateSelected((e) => { e.loadFactor = v; })} />
                    <div className="field"><label>{t('layout.sel.blanking')}</label><Toggle label={single.blanking === false ? t('layout.sel.blankingOff') : t('layout.sel.blankingOn')} checked={single.blanking !== false} onChange={(v) => mutateSelected((e) => { e.blanking = v; })} /></div>
                    {singleItem.category === 'network-rack' && (
                      <SelectField label={t('layout.sel.role')} value={single.networkRole ?? 'mixed'}
                        options={(['scale-out-leaf', 'scale-out-spine', 'scale-out-core', 'frontend', 'storage', 'oob', 'mixed', 'inter-hall-core'] as const).map((r) => ({ value: r, label: r }))}
                        onChange={(v) => mutateSelected((e) => { e.networkRole = v; })} />
                    )}
                  </div>
                </div>
                <div className="grid-3" style={{ marginTop: 8 }}>
                  <Stat label={t('layout.sel.dims')} value={<span style={{ fontSize: 14 }}>{singleItem.dims.w}×{singleItem.dims.d}×{singleItem.dims.h} m</span>} delta={`${fmtInt(singleItem.weightKg)} kg`} />
                  <Stat label={t('layout.sel.power')} value={fmtPower(equipmentKW(single.catalogId, single.loadFactor ?? 1))} delta={singleItem.power ? t('layout.sel.peakIdle', { peak: fmtPower(singleItem.power.peakKW), idle: fmtPower(singleItem.power.idleKW) }) : singleItem.capacity?.coolingKW ? t('layout.sel.capacity', { v: fmtPower(singleItem.capacity.coolingKW) }) : undefined} />
                  <Stat label={t('layout.sel.unitPrice')} value={fmtMoney(project.pricing.itemOverrides[singleItem.id] ?? singleItem.cost.capexUSD, project.pricing)} delta={t('layout.sel.lead', { w: singleItem.cost.leadTimeWeeks })} />
                </div>
                {singleItem.cooling && singleItem.cooling.liquidFraction > 0 && (
                  <p className="hint">{t('layout.sel.liquid', { pct: Math.round(singleItem.cooling.liquidFraction * 100), flow: singleItem.cooling.airflowM3s.toFixed(2), lpm: singleItem.cooling.liquidFlowLpm ?? 0 })}</p>
                )}
                {singleItem.compute && singleItem.compute.gpus > 0 && (
                  <p className="hint">{t('layout.sel.gpu', { n: singleItem.compute.gpus, model: singleItem.compute.gpuModel, domain: singleItem.compute.scaleUp.domainSize, ports: singleItem.compute.scaleOutPortsPerGpu, gbps: singleItem.compute.scaleOutPortGbps })}</p>
                )}
                {singleItem.notes && <p className="hint">{singleItem.notes}</p>}
              </>
            ) : (
              <>
                <div className="grid-2">
                  <Stat label={t('layout.sel.totalPower')} value={fmtPower(selected.reduce((a, e) => a + equipmentKW(e.catalogId, e.loadFactor ?? 1), 0))} />
                  <Stat label={t('layout.sel.totalPrice')} value={fmtMoney(selected.reduce((a, e) => a + (findCatalogItem(e.catalogId)?.cost.capexUSD ?? 0), 0), project.pricing)} />
                </div>
                <SelectField label={t('layout.sel.waveBulk')} value="" options={[{ value: '', label: '—' }, ...project.schedule.waves.map((w) => ({ value: w.id, label: w.name }))]} onChange={(v) => v && mutateSelected((e) => { e.waveId = v; })} />
                <NumberField label={t('layout.sel.loadBulk')} step={0.05} value={1} onChange={(v) => mutateSelected((e) => { e.loadFactor = v; })} />
              </>
            )}
            <div className="row wrap" style={{ marginTop: 10 }}>
              <button className="btn sm" onClick={() => mutateSelected((e) => { e.rotationDeg = ((e.rotationDeg + 90) % 360) as EquipmentInstance['rotationDeg']; })}><Icon name="rotate" size={13} />{t('layout.sel.rotate')}</button>
              <button className="btn sm" onClick={() => {
                const ids: string[] = [];
                update((d) => {
                  d.equipment.filter((e) => selection.includes(e.id)).forEach((e) => {
                    const id = `eq-${Math.random().toString(36).slice(2, 9)}`;
                    ids.push(id);
                    d.equipment.push({ ...structuredClone(e), id, tag: `${e.tag}-copy`, position: { x: e.position.x, y: e.position.y + 1.8 } });
                  });
                });
                setSelection(ids);
              }}><Icon name="copy" size={13} />{t('layout.sel.duplicate')}</button>
              <button className={`btn sm ${editMode ? 'active' : ''}`} onClick={() => setEditMode(!editMode)}><Icon name="move" size={13} />{t('layout.sel.move')}</button>
              <span className="grow" />
              <button className="btn danger sm" onClick={() => { update((d) => { d.equipment = d.equipment.filter((e) => !selection.includes(e.id)); }); select(null); }}><Icon name="trash" size={13} />{t('layout.sel.delete')}</button>
            </div>
          </div>
        </Section>
      )}

      <Section title={t('layout.list.title', { n: eq.length })}>
        <div className="row" style={{ marginBottom: 6 }}>
          <div style={{ width: 170 }}>
            <Select value={filter} options={[{ value: 'all', label: t('layout.list.allKinds') }, ...cats.map((c) => ({ value: c, label: t(`layout.cat.${c}`) }))]} onChange={setFilter} />
          </div>
          <input type="text" placeholder={t('layout.list.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <DataTable
          columns={[
            { key: 'tag', header: t('layout.list.col.tag'), render: (e: EquipmentInstance) => <span className="mono">{e.tag}</span>, sortValue: (e) => e.tag },
            { key: 'model', header: t('layout.list.col.model'), render: (e) => findCatalogItem(e.catalogId)?.model ?? e.catalogId, sortValue: (e) => e.catalogId },
            { key: 'wave', header: t('layout.list.col.wave'), render: (e) => project.schedule.waves.find((w) => w.id === e.waveId)?.name ?? '—', sortValue: (e) => e.waveId ?? '' },
            { key: 'pos', header: t('layout.list.col.pos'), num: true, render: (e) => `${e.position.x.toFixed(2)}, ${e.position.y.toFixed(2)}` },
            { key: 'kw', header: t('layout.list.col.kw'), num: true, render: (e) => fmt1(equipmentKW(e.catalogId, e.loadFactor ?? 1)), sortValue: (e) => equipmentKW(e.catalogId, e.loadFactor ?? 1) },
          ]}
          rows={rows}
          rowKey={(e) => e.id}
          selectedKeys={selection}
          onRowClick={(e, ev) => select(e.id, ev.ctrlKey || ev.metaKey || ev.shiftKey)}
          maxHeight={360}
        />
      </Section>

      <Section title={t('layout.cont.title', { n: project.containments.filter((c) => c.hallId === hall.id).length, t: (project.trays ?? []).filter((x) => x.hallId === hall.id).length, b: (project.busways ?? []).filter((b) => b.hallId === hall.id).length })}>
        <DataTable
          columns={[
            { key: 'id', header: t('layout.cont.col.pod'), render: (c: Containment) => c.podId ?? c.id },
            { key: 'k', header: t('layout.cont.col.kind'), render: (c) => (c.kind === 'hot-aisle' ? 'HAC' : 'CAC') },
            { key: 'size', header: t('layout.cont.col.size'), num: true, render: (c) => `${c.rect.w.toFixed(1)}×${c.rect.d.toFixed(2)} m` },
            ...(['roof', 'endDoors', 'ductedToPlenum'] as const).map((k) => ({
              key: k, header: k === 'roof' ? t('layout.cont.col.roof') : k === 'endDoors' ? t('layout.cont.col.doors') : t('layout.cont.col.duct'),
              render: (c: Containment) => <input type="checkbox" checked={c[k]} onChange={(ev) => update((d) => { d.containments.find((x) => x.id === c.id)![k] = ev.target.checked; })} />,
            })),
            { key: 'del', header: '', render: (c: Containment) => <button className="btn ghost sm" onClick={() => update((d) => { d.containments = d.containments.filter((x) => x.id !== c.id); })}><Icon name="trash" size={13} /></button> },
          ]}
          rows={project.containments.filter((c) => c.hallId === hall.id)}
          rowKey={(c) => c.id}
          maxHeight={220}
        />
      </Section>
    </div>
  );
}

/**
 * stream E (P5, proposal §4.2 / §6.1): compute platforms for a template slot ordered by eligibility under the hall's standards profile —
 * registered + eligible first, then eligible, then ineligible greyed with the failing rules (EN / KO from the engine); items behind the
 * drafts toggle are counted, not listed. Eligibility reads declared standards only (layout/templates/eligibility.ts).
 */
function SlotEligibilityList({ templateId, slotId, currentId, hallId }: { templateId: string; slotId: string; currentId: string; hallId: string }) {
  const t = useT();
  const project = useApp((s) => s.project);
  const locale = useApp((s) => s.uiLocale);
  const std = effectiveStandardsProfile(project, hallId);
  const drafts = std?.includeDraftSpecs ?? false;
  const shelf = std?.shelfClass;
  const { cands, hidden } = useMemo(() => {
    try {
      const prof = { includeDraftSpecs: drafts, ...(shelf ? { shelfClass: shelf } : {}) };
      const shown = slotCandidates(templateId, slotId, { project, profile: prof });
      const all = slotCandidates(templateId, slotId, { project, profile: prof, includeHidden: true });
      return { cands: shown, hidden: all.length - shown.length };
    } catch {
      return { cands: [], hidden: 0 };
    }
  }, [templateId, slotId, project, drafts, shelf]);
  const curElig = currentId ? platformEligibility(templateId, slotId, currentId, { includeDraftSpecs: drafts, ...(shelf ? { shelfClass: shelf } : {}) }) : undefined;
  const txt = (r: { en: string; ko: string }) => (locale === 'ko' ? r.ko : r.en);
  if (!cands.length) return null;
  return (
    <>
      {curElig && !curElig.eligible && (
        <div className="small" style={{ margin: '-4px 0 8px', padding: '4px 8px', borderLeft: '3px solid var(--warning)' }} data-slot-ineligible={currentId}>
          {t('standards.ui.elig.current', { reasons: curElig.reasons.map(txt).join('; ') })}
        </div>
      )}
      <details style={{ margin: '-4px 0 10px' }} data-slot-eligibility={slotId}>
        <summary className="small" style={{ cursor: 'pointer' }}>{t('standards.ui.elig.title', { eligible: cands.filter((c) => c.eligible).length, total: cands.length })}</summary>
        <div style={{ maxHeight: 240, overflowY: 'auto', paddingTop: 4 }}>
          {cands.map((c) => (
            <div key={c.catalogId} className="small" style={{ padding: '3px 0', opacity: c.eligible ? 1 : 0.6 }} data-elig={c.eligible ? 'eligible' : 'ineligible'} data-elig-id={c.catalogId} title={c.notes.map(txt).join('\n') || undefined}>
              <span className={`badge ${c.eligible ? 'src-open-standard' : ''}`}>{t(c.eligible ? 'standards.ui.elig.eligible' : 'standards.ui.elig.ineligible')}</span>{' '}
              {c.name}
              {c.registered && <span className="hint"> · {t('standards.ui.elig.registered')}</span>}
              {c.draftChip && <> <span className="badge warn" title={t('standards.chip.draftTip')}>{t('standards.chip.draft')}</span></>}
              {!c.eligible && <div className="hint" style={{ marginLeft: 8 }}>{c.reasons.map(txt).join('; ')}</div>}
              {c.eligible && c.notes.length > 0 && <div className="hint" style={{ marginLeft: 8 }}>{t('standards.ui.elig.notes')}: {c.notes.map(txt).join('; ')}</div>}
            </div>
          ))}
          {hidden > 0 && <div className="hint">{t('standards.ui.elig.hidden', { n: hidden })}</div>}
        </div>
      </details>
    </>
  );
}
