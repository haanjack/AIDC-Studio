import { announcedSpec } from '@aidc/core';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  CATALOG_IMAGE_MAX_BYTES, MFU_BASIS, allowedThumbnails, MFU_PRECISIONS, NODE_SPECS, RACK_MODELS, cableTypes, catalogImage, catalogImageDataUrlBytes, catalogItems, composeRack,
  findCatalogItem, findNodeSpec, findRackModel, findStandard, itemStandardsChips, standardCitation, maxNodesPerRack, mfuBasisFor, moveRackComponent, placeRackComponents, rackComponentsFor, setCatalogThumbnails,
  type CableType, type CatalogItem, type CatalogLibrary, type EquipmentCategory, type SpecSource, type UMapEntry,
} from '@aidc/core';
import { libraryCache, useApp } from '../store/appStore.ts';
import { PLACEABLE, findFreeSpot } from '../app/derived.ts';
import { downloadText } from '../app/api.ts';
import { fmtInt } from '../app/format.ts';
import { useT, type TParams } from '../i18n/index.ts';
import { DataTable, Empty, Field, NumberField, Section, Seg, Select, SelectField, SourceBadge, Stat, TextField, Toggle } from '../ui/controls.tsx';
import { Icon } from '../ui/icons.tsx';
import { RackBlueprint, type RackBlueprintEntry } from '../ui/RackBlueprint.tsx';
// stream E (P5, proposal §6.1–6.2): standards filters, text-only chips, standards table and parameter provenance
import { FACET_LABEL_KIND, STANDARDS_FACETS, draftHidden, facetValues, matchesStandardsFilter, type StandardsFacet, type StandardsFilter } from '../app/standardsUi.ts';

/**
 * Catalog panel (stream S3, proposal §3.7; T5 2차: images, rack blueprint composer, save guidance, i18n 'catalog').
 * Effective catalog (builtin ∪ server library ∪ project extensions) with filters, a detail view with image / source
 * badges / links / MFU basis / rack blueprint, "clone to edit", a validated edit form with image upload, the node →
 * rack composer on a fixed rack blueprint, JSON import/export and a save target (project / server library). After a
 * save an inline card says where the item lives and where it can be used.
 */

type Tab = 'items' | 'cables' | 'composer';
type Target = 'project' | 'library';
type Origin = NonNullable<CatalogItem['origin']>;
type T = (key: string, params?: TParams) => string;

const ORIGINS: Origin[] = ['builtin', 'library', 'project'];
const SOURCES: SpecSource[] = ['user', 'estimate', 'announced', 'public-spec', 'vendor-datasheet', 'open-standard'];
const CATEGORIES: EquipmentCategory[] = [
  'gpu-rack', 'cpu-rack', 'storage-rack', 'network-rack', 'mgmt-rack', 'switch', 'nic', 'cdu', 'crah', 'fan-wall', 'rpp', 'busway-tapoff', 'ups',
  'battery', 'transformer', 'generator', 'switchgear', 'chiller', 'dry-cooler', 'cooling-tower', 'column', 'other',
];
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

const originLabel = (t: T, o: Origin) => t(`catalog.origin.${o}`);
const catLabel = (t: T, c: EquipmentCategory) => t(`catalog.cat.${c}`);
const sourceOptions = (t: T) => SOURCES.map((s) => ({ value: s, label: t(`catalog.source.${s}`) }));
const categoryOptions = (t: T) => CATEGORIES.map((c) => ({ value: c, label: catLabel(t, c) }));

// thumbnails listed in assets/manifest.json (render_thumbs.py) for redistributable generated models only — loaded once per session
let thumbsPromise: Promise<void> | null = null;
function loadThumbnails(): Promise<void> {
  thumbsPromise ??= fetch('/assets/manifest.json')
    .then((r) => (r.ok ? r.json() : null))
    .then((m: { thumbs?: Record<string, string> } | null) => { if (m) setCatalogThumbnails(allowedThumbnails(m), '/assets/'); })
    .catch(() => undefined);
  return thumbsPromise;
}

// ───────────── path helpers for the generic edit form ─────────────
function getPath(o: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((a, k) => (a && typeof a === 'object' ? (a as Record<string, unknown>)[k] : undefined), o);
}
function setPath<U extends object>(o: U, path: string, v: unknown): U {
  const out = structuredClone(o) as Record<string, unknown>;
  const keys = path.split('.');
  let cur: Record<string, unknown> = out;
  for (const k of keys.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = v;
  return out as U;
}

interface NumField { path: string; key: string; unit?: string; step?: number; min?: number }
const FORM_GROUPS: { key: keyof CatalogItem | 'base'; fields: NumField[]; optional?: boolean }[] = [
  { key: 'base', fields: [
    { path: 'dims.w', key: 'dimsW', unit: 'm', step: 0.01, min: 0.01 }, { path: 'dims.d', key: 'dimsD', unit: 'm', step: 0.01, min: 0.01 }, { path: 'dims.h', key: 'dimsH', unit: 'm', step: 0.01, min: 0.01 },
    { path: 'weightKg', key: 'weight', unit: 'kg', step: 10, min: 0 }, { path: 'rackUnits', key: 'rackUnits', unit: 'U', step: 1, min: 0 },
    { path: 'clearance.front', key: 'clearFront', unit: 'm', step: 0.1, min: 0 }, { path: 'clearance.rear', key: 'clearRear', unit: 'm', step: 0.1, min: 0 }, { path: 'clearance.sides', key: 'clearSides', unit: 'm', step: 0.1, min: 0 },
  ] },
  { key: 'power', optional: true, fields: [
    { path: 'power.nameplateKW', key: 'nameplate', unit: 'kW', step: 0.1, min: 0 }, { path: 'power.typicalKW', key: 'typical', unit: 'kW', step: 0.1, min: 0 }, { path: 'power.idleKW', key: 'idle', unit: 'kW', step: 0.1, min: 0 }, { path: 'power.peakKW', key: 'peak', unit: 'kW', step: 0.1, min: 0 },
    { path: 'power.feeds', key: 'feeds', step: 1, min: 0 }, { path: 'power.voltageV', key: 'voltage', unit: 'V', step: 1, min: 0 }, { path: 'power.rampUpKWps', key: 'rampUp', unit: 'kW/s', step: 1, min: 0 }, { path: 'power.rampDownKWps', key: 'rampDown', unit: 'kW/s', step: 1, min: 0 },
  ] },
  { key: 'cooling', optional: true, fields: [
    { path: 'cooling.liquidFraction', key: 'liquidFraction', step: 0.01, min: 0 }, { path: 'cooling.airflowM3s', key: 'airflow', unit: 'm³/s', step: 0.01, min: 0 }, { path: 'cooling.liquidFlowLpm', key: 'tcsFlow', unit: 'LPM', step: 1 , min: 0 },
    { path: 'cooling.maxInletC', key: 'maxInlet', unit: '°C', step: 1 }, { path: 'cooling.maxCoolantSupplyC', key: 'maxCoolant', unit: '°C', step: 1 },
  ] },
  { key: 'compute', optional: true, fields: [
    { path: 'compute.gpus', key: 'gpus', step: 1, min: 0 }, { path: 'compute.cpus', key: 'cpus', step: 1, min: 0 }, { path: 'compute.gpusPerNode', key: 'gpusPerNode', step: 1, min: 0 }, { path: 'compute.nodesPerRack', key: 'nodesPerRack', step: 1, min: 0 },
    { path: 'compute.gpuMemoryGB', key: 'gpuMemory', unit: 'GB', step: 1, min: 0 }, { path: 'compute.memBandwidthGBps', key: 'hbmBandwidth', unit: 'GB/s', step: 100, min: 0 }, { path: 'compute.gpuFlopsPeak', key: 'gpuFlops', unit: 'FLOPS', step: 1e14, min: 0 },
    { path: 'compute.peakTflops.bf16', key: 'tflopsBf16', unit: 'TFLOPS', step: 10, min: 0 }, { path: 'compute.peakTflops.fp8', key: 'tflopsFp8', unit: 'TFLOPS', step: 10, min: 0 }, { path: 'compute.peakTflops.fp4', key: 'tflopsFp4', unit: 'TFLOPS', step: 10, min: 0 },
    { path: 'compute.scaleUp.domainSize', key: 'scaleUpDomain', step: 1, min: 0 }, { path: 'compute.scaleUp.gbpsPerGpu', key: 'scaleUpGbps', unit: 'Gb/s', step: 100, min: 0 }, { path: 'compute.railsPerNode', key: 'rails', step: 1, min: 0 },
    { path: 'compute.scaleOutPortsPerGpu', key: 'soPorts', step: 0.25, min: 0 }, { path: 'compute.scaleOutPortGbps', key: 'soGbps', unit: 'Gb/s', step: 100, min: 0 },
    { path: 'compute.frontendPorts', key: 'fePorts', step: 1, min: 0 }, { path: 'compute.frontendPortGbps', key: 'feGbps', unit: 'Gb/s', step: 100, min: 0 },
    { path: 'compute.storagePorts', key: 'stPorts', step: 1, min: 0 }, { path: 'compute.storagePortGbps', key: 'stGbps', unit: 'Gb/s', step: 100, min: 0 }, { path: 'compute.oobPorts', key: 'oobPorts', step: 1, min: 0 },
  ] },
  { key: 'switch', optional: true, fields: [
    { path: 'switch.ports', key: 'swPorts', step: 1, min: 1 }, { path: 'switch.portGbps', key: 'swGbps', unit: 'Gb/s', step: 100, min: 1 }, { path: 'switch.rackUnits', key: 'swRu', step: 1, min: 1 },
    { path: 'switch.netPorts', key: 'swNetPorts', step: 1, min: 0 }, { path: 'switch.fabricPorts', key: 'swFabricPorts', step: 1, min: 0 },
  ] },
  { key: 'capacity', optional: true, fields: [
    { path: 'capacity.coolingKW', key: 'capCooling', unit: 'kW', step: 10, min: 0 }, { path: 'capacity.airflowM3s', key: 'capAirflow', unit: 'm³/s', step: 0.1, min: 0 }, { path: 'capacity.liquidFlowLpm', key: 'capFlow', unit: 'LPM', step: 10, min: 0 },
    { path: 'capacity.powerKVA', key: 'capKva', unit: 'kVA', step: 10, min: 0 }, { path: 'capacity.powerKW', key: 'capKw', unit: 'kW', step: 10, min: 0 }, { path: 'capacity.currentA', key: 'capCurrent', unit: 'A', step: 10, min: 0 },
    { path: 'capacity.inputVoltageV', key: 'capVin', unit: 'V', step: 1, min: 0 }, { path: 'capacity.outputVoltageV', key: 'capVout', unit: 'V', step: 1, min: 0 }, { path: 'capacity.batteryMinutes', key: 'capBattery', unit: 'min', step: 1, min: 0 },
  ] },
  { key: 'cost', fields: [
    { path: 'cost.capexUSD', key: 'capex', unit: 'USD', step: 1000, min: 0 }, { path: 'cost.installHours', key: 'installHours', unit: 'h', step: 1, min: 0 }, { path: 'cost.leadTimeWeeks', key: 'leadTime', unit: 'wk', step: 1, min: 0 },
  ] },
];

const DEFAULT_BLOCK: Record<string, unknown> = {
  power: { nameplateKW: 10, typicalKW: 8, idleKW: 2, peakKW: 11, feeds: 2, voltageV: 415 },
  cooling: { liquidFraction: 0, airflowM3s: 0.5, liquidFlowLpm: 0, maxInletC: 35 },
  compute: { gpus: 0, gpuModel: '-', cpus: 0, cpuModel: 'x86', scaleUp: { kind: 'none', domainSize: 0, gbpsPerGpu: 0 }, scaleOutPortsPerGpu: 0, scaleOutPortGbps: 0, frontendPorts: 0, frontendPortGbps: 0, storagePorts: 0, storagePortGbps: 0, oobPorts: 0, gpuMemoryGB: 0, gpuFlopsPeak: 0 },
  switch: { fabric: 'roce-generic-400', ports: 64, portGbps: 800, rackUnits: 2, role: 'any' },
  capacity: { coolingKW: 0 },
};

/** Client-side validation (mirrors apps/server/src/catalogStore.ts). `t` is optional so non-React callers keep working. */
export function validateCatalogItem(it: CatalogItem, takenIds: Set<string>, t: T = (k) => k): string[] {
  const e: string[] = [];
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  if (!ID_RE.test(it.id)) e.push(t('catalog.val.id'));
  if (takenIds.has(it.id)) e.push(t('catalog.val.idTaken', { id: it.id }));
  if (!it.name?.trim()) e.push(t('catalog.val.name'));
  if (!it.category) e.push(t('catalog.val.category'));
  if (!(num(it.dims?.w) && it.dims.w > 0 && num(it.dims?.d) && it.dims.d > 0 && num(it.dims?.h) && it.dims.h > 0)) e.push(t('catalog.val.dims'));
  if (!num(it.weightKg) || it.weightKg < 0) e.push(t('catalog.val.weight'));
  if (!it.cost || !num(it.cost.capexUSD) || !num(it.cost.installHours) || !num(it.cost.leadTimeWeeks)) e.push(t('catalog.val.cost'));
  if (!SOURCES.includes(it.source)) e.push(t('catalog.val.source'));
  if (it.power) {
    const p = it.power;
    if (![p.nameplateKW, p.typicalKW, p.idleKW, p.peakKW, p.feeds, p.voltageV].every(num)) e.push(t('catalog.val.powerFields'));
    else {
      if (p.idleKW > p.nameplateKW + 1e-9) e.push(t('catalog.val.idle'));
      if (p.typicalKW > p.peakKW + 1e-9) e.push(t('catalog.val.typical'));
    }
  }
  if (it.cooling && (!num(it.cooling.liquidFraction) || it.cooling.liquidFraction < 0 || it.cooling.liquidFraction > 1)) e.push(t('catalog.val.liquid'));
  if (it.category === 'gpu-rack' && (!it.compute || !(it.compute.gpus > 0))) e.push(t('catalog.val.gpuRack'));
  if (it.compute && (!it.compute.scaleUp || !num(it.compute.scaleUp.domainSize) || !num(it.compute.scaleUp.gbpsPerGpu))) e.push(t('catalog.val.scaleUp'));
  if (it.category === 'switch' && !it.switch) e.push(t('catalog.val.switch'));
  if (it.compute && it.compute.nodesPerRack && it.compute.gpusPerNode && it.compute.nodesPerRack * it.compute.gpusPerNode !== it.compute.gpus) e.push(t('catalog.val.nodesGpus'));
  if (it.image?.dataUrl) {
    const n = catalogImageDataUrlBytes(it.image.dataUrl);
    if (n < 0) e.push(t('catalog.val.imageType'));
    else if (n > CATALOG_IMAGE_MAX_BYTES) e.push(t('catalog.val.imageSize', { kb: Math.round(n / 1024) }));
  }
  return e;
}

function stripOrigin<U extends { origin?: unknown }>(x: U): U {
  const { origin: _o, ...rest } = x;
  return rest as U;
}

interface SavedInfo { id: string; name: string; layer: Target; category: EquipmentCategory; offline: boolean; placed?: { tag: string; hall: string } }

// ───────────── panel ─────────────
export function CatalogPanel() {
  const t = useT();
  const project = useApp((s) => s.project);
  const libraryVersion = useApp((s) => s.libraryVersion);
  const serverOnline = useApp((s) => s.serverOnline);
  const update = useApp((s) => s.update);
  const saveLibrary = useApp((s) => s.saveLibrary);
  const notify = useApp((s) => s.notify);
  const [tab, setTab] = useState<Tab>('items');
  const [target, setTarget] = useState<Target>('project');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<CatalogItem | null>(null);
  const [cableDraft, setCableDraft] = useState<string | null>(null);
  const [originFilter, setOriginFilter] = useState<Origin | 'all'>('all');
  const [saved, setSaved] = useState<SavedInfo | null>(null);
  const [thumbsVersion, setThumbsVersion] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { void loadThumbnails().then(() => setThumbsVersion((v) => v + 1)); }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const items = useMemo(() => catalogItems(), [project, libraryVersion]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const cables = useMemo(() => cableTypes(), [project, libraryVersion]);
  const counts = useMemo(() => ({
    builtin: items.filter((i) => (i.origin ?? 'builtin') === 'builtin').length,
    library: items.filter((i) => i.origin === 'library').length,
    project: items.filter((i) => i.origin === 'project').length,
  }), [items]);

  const selected = selectedId ? items.find((i) => i.id === selectedId) ?? null : null;

  // ───── persistence helpers ─────
  const idsIn = (tg: Target, exceptId?: string) => new Set((tg === 'project' ? project.catalogExtensions ?? [] : libraryCache.items ?? []).map((i) => i.id).filter((id) => id !== exceptId));

  const upsert = async (item: CatalogItem, tg: Target) => {
    const clean = stripOrigin(item);
    if (tg === 'project') {
      update((d) => {
        const ext = d.catalogExtensions ?? [];
        const i = ext.findIndex((x) => x.id === clean.id);
        if (i >= 0) ext[i] = clean; else ext.push(clean);
        d.catalogExtensions = ext;
      });
    } else {
      const lib: CatalogLibrary = { items: [...(libraryCache.items ?? []).filter((x) => x.id !== clean.id).map(stripOrigin), clean], cables: (libraryCache.cables ?? []).map(stripOrigin) };
      await saveLibrary(lib);
    }
    const libDirty = tg === 'library' && useApp.getState().libraryDirty;
    notify(t('catalog.save.toast', { name: clean.name, layer: tg === 'project' ? t('catalog.layer.project') : libDirty ? t('catalog.layer.libraryOffline') : t('catalog.layer.library') }), libDirty ? 'info' : 'ok');
    setSaved({ id: clean.id, name: clean.name, layer: tg, category: clean.category, offline: libDirty });
    setDraft(null);
    if (tab === 'items') setSelectedId(clean.id);
  };

  const remove = async (item: CatalogItem) => {
    const used = project.equipment.filter((e) => e.catalogId === item.id).length;
    if (used && !window.confirm(t('catalog.confirmDelete', { name: item.name, n: used }))) return;
    if (item.origin === 'project') update((d) => { d.catalogExtensions = (d.catalogExtensions ?? []).filter((x) => x.id !== item.id); });
    else if (item.origin === 'library') await saveLibrary({ items: (libraryCache.items ?? []).filter((x) => x.id !== item.id).map(stripOrigin), cables: (libraryCache.cables ?? []).map(stripOrigin) });
    setSelectedId(null);
    setDraft(null);
    if (saved?.id === item.id) setSaved(null);
  };

  const clone = (item: CatalogItem) => {
    const base = stripOrigin(structuredClone(item));
    const taken = idsIn(target);
    let id = `${item.id}-copy`;
    for (let i = 2; taken.has(id) || items.some((x) => x.id === id); i++) id = `${item.id}-copy${i}`;
    setDraft({ ...base, id, name: t('catalog.cloneName', { name: item.name }), source: 'user', notes: `${item.notes ? `${item.notes} ` : ''}Cloned from ${item.id} (${item.source}).` });
  };

  const blank = () => setDraft({
    id: 'custom-item', category: 'gpu-rack', vendor: 'Custom', model: 'Custom', name: t('catalog.newItemName'), description: '',
    dims: { w: 0.6, d: 1.2, h: 2.3 }, weightKg: 1000, clearance: { front: 1.2, rear: 0.9, sides: 0 },
    power: { nameplateKW: 40, typicalKW: 32, idleKW: 8, peakKW: 44, feeds: 2, voltageV: 415 },
    cooling: { liquidFraction: 0, airflowM3s: 2, liquidFlowLpm: 0, maxInletC: 35 },
    compute: { ...(DEFAULT_BLOCK.compute as CatalogItem['compute'])!, gpus: 8, gpuModel: 'GPU', cpus: 2, scaleUp: { kind: 'vendor-proprietary', domainSize: 8, gbpsPerGpu: 7200 }, scaleOutPortsPerGpu: 1, scaleOutPortGbps: 400, gpuMemoryGB: 80, gpuFlopsPeak: 1e15, nodesPerRack: 1, gpusPerNode: 8 },
    cost: { capexUSD: 250_000, installHours: 8, leadTimeWeeks: 12 }, source: 'user', asset: { color: '#3a3f44' },
  });

  // ───── save guidance actions ─────
  const showInList = (info: SavedInfo) => {
    setTab('items');
    setOriginFilter(info.layer);
    setSelectedId(info.id);
    setDraft(null);
  };
  const openLayoutAdd = (info: SavedInfo) => {
    const st = useApp.getState();
    st.setPendingAddCatalogId(info.id);
    st.setPage('layout');
  };
  const openArchitecture = (info: Pick<SavedInfo, 'id'>) => {
    const st = useApp.getState();
    st.setPendingArchitectureRackId(info.id);
    st.setPage('architecture');
  };
  const placeInHall = (info: SavedInfo) => {
    const st = useApp.getState();
    const item = findCatalogItem(info.id);
    const hall = st.project.halls.find((h) => h.id === st.hallId);
    if (!item || !hall) return notify(t('catalog.save.notFound'), 'error');
    if (!PLACEABLE.includes(item.category)) return notify(t('catalog.save.notPlaceable', { category: catLabel(t, item.category) }), 'error');
    const pos = findFreeSpot(st.project, hall.id, item, 0);
    if (!pos) return notify(t('catalog.save.noSpot', { hall: hall.name }), 'error');
    const eqId = `eq-${Date.now().toString(36)}`;
    const tag = `${item.model.replace(/\s+/g, '').slice(0, 8).toUpperCase()}-${st.project.equipment.filter((e) => e.catalogId === item.id).length + 1}`;
    st.update((d) => { d.equipment.push({ id: eqId, catalogId: item.id, hallId: hall.id, tag, position: pos, rotationDeg: 0, blanking: true, waveId: d.schedule.waves[0]?.id }); });
    st.select(eqId);
    // the catalog page opens wide (viewport unmounted): show the 3D view, then focus once the NEW viewer reports ready
    const wasHidden = st.panelWide && !st.panelCollapsed;
    const staleApi = st.viewerApi;
    st.setPanelWide(false);
    const started = Date.now();
    const focusWhenReady = () => {
      const api = useApp.getState().viewerApi;
      if (api && (!wasHidden || api !== staleApi)) api.focusEquipment(eqId);
      else if (Date.now() - started < 8000) setTimeout(focusWhenReady, 150);
    };
    setTimeout(focusWhenReady, 150);
    setSaved({ ...info, placed: { tag, hall: hall.name } });
    notify(t('catalog.save.placedToast', { tag, hall: hall.name, x: pos.x.toFixed(1), y: pos.y.toFixed(1) }), 'ok');
  };

  // ───── import / export ─────
  const exportJson = () => {
    const body = target === 'project'
      ? { items: (project.catalogExtensions ?? []).map(stripOrigin), cables: (project.cableExtensions ?? []).map(stripOrigin) }
      : { items: (libraryCache.items ?? []).map(stripOrigin), cables: (libraryCache.cables ?? []).map(stripOrigin) };
    downloadText(JSON.stringify(body, null, 2), `aidc-catalog-${target}-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
  };
  const importJson = async (file: File) => {
    try {
      const raw = JSON.parse(await file.text()) as { items?: CatalogItem[]; cables?: CableType[] } | CatalogItem[];
      const lib = Array.isArray(raw) ? { items: raw, cables: [] } : { items: raw.items ?? [], cables: raw.cables ?? [] };
      const errs: string[] = [];
      const seen = new Set<string>();
      lib.items.forEach((it, i) => { const e = validateCatalogItem(it, seen, t); if (e.length) errs.push(`items[${i}] ${it?.id ?? ''}: ${e.join('; ')}`); seen.add(it.id); });
      if (errs.length) { notify(t('catalog.import.failed', { msg: `${errs.slice(0, 3).join(' | ')}${errs.length > 3 ? ` (+${errs.length - 3})` : ''}` }), 'error'); return; }
      const cleanItems = lib.items.map(stripOrigin);
      const cleanCables = lib.cables.map(stripOrigin);
      if (target === 'project') {
        update((d) => {
          const byId = new Map((d.catalogExtensions ?? []).map((x) => [x.id, x]));
          cleanItems.forEach((x) => byId.set(x.id, x));
          d.catalogExtensions = [...byId.values()];
          const cById = new Map((d.cableExtensions ?? []).map((x) => [x.id, x]));
          cleanCables.forEach((x) => cById.set(x.id, x));
          d.cableExtensions = [...cById.values()];
        });
      } else {
        const byId = new Map((libraryCache.items ?? []).map((x) => [x.id, stripOrigin(x)]));
        cleanItems.forEach((x) => byId.set(x.id, x));
        const cById = new Map((libraryCache.cables ?? []).map((x) => [x.id, stripOrigin(x)]));
        cleanCables.forEach((x) => cById.set(x.id, x));
        await saveLibrary({ items: [...byId.values()], cables: [...cById.values()] });
      }
      const layer = target === 'project' ? t('catalog.layer.project') : useApp.getState().libraryDirty ? t('catalog.layer.libraryOffline') : t('catalog.layer.library');
      notify(t('catalog.import.merged', { items: cleanItems.length, cables: cleanCables.length, layer }), 'ok');
    } catch (e) {
      notify(t('catalog.import.failed', { msg: (e as Error).message }), 'error');
    }
  };

  const targetHint = target === 'project' ? t('catalog.target.projectHint') : serverOnline ? t('catalog.target.libraryHint') : t('catalog.target.libraryOfflineHint');

  return (
    <div data-thumbs={thumbsVersion}>
      <div className="row wrap" style={{ gap: 10, marginTop: 8 }}>
        {/* verify v2 2차: the tab switcher is view navigation — keep it usable under a read-only lock */}
        <span data-ro-allow style={{ display: 'contents' }}>
        <Seg value={tab} options={[{ value: 'items', label: t('catalog.tab.items', { n: items.length }) }, { value: 'cables', label: t('catalog.tab.cables', { n: cables.length }) }, { value: 'composer', label: t('catalog.tab.composer') }]} onChange={(v) => { setTab(v); setDraft(null); setCableDraft(null); }} />
        </span>
        <span className="grow" />
        <span className="secondary" style={{ fontSize: 12 }}>{t('catalog.target.label')}</span>
        <Seg value={target} options={[{ value: 'project', label: t('catalog.origin.project') }, { value: 'library', label: t('catalog.origin.library') }]} onChange={setTarget} />
        <button className="btn sm" title={t('catalog.export.tooltip')} onClick={exportJson}><Icon name="download" size={13} />{t('catalog.export.button')}</button>
        <button className="btn sm" title={t('catalog.import.tooltip')} onClick={() => fileRef.current?.click()}><Icon name="upload" size={13} />{t('catalog.import.button')}</button>
        <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importJson(f); e.target.value = ''; }} />
      </div>
      <p className="hint" style={{ margin: '6px 0 0' }}>
        {t('catalog.activeSummary', { builtin: counts.builtin, library: counts.library, project: counts.project })} {targetHint}
      </p>

      {saved && (
        <SaveLocationCard
          info={saved} onClose={() => setSaved(null)} onShowInList={() => showInList(saved)} onLayoutAdd={() => openLayoutAdd(saved)}
          onArchitecture={() => openArchitecture(saved)} onPlace={() => placeInHall(saved)}
        />
      )}

      {tab === 'items' && (
        <ItemsTab
          items={items} selected={selected} onSelect={(id) => { setSelectedId(id); setDraft(null); }}
          draft={draft} setDraft={setDraft} onClone={clone} onNew={blank} onDelete={(it) => void remove(it)}
          onSave={(it) => void upsert(it, target)} target={target} takenIds={(exceptId) => idsIn(target, exceptId)} project={project}
          origin={originFilter} setOrigin={setOriginFilter} onConfigure={openArchitecture}
        />
      )}
      {tab === 'cables' && (
        <CablesTab cables={cables} target={target} draft={cableDraft} setDraft={setCableDraft} project={project} update={update} saveLibrary={saveLibrary} notify={notify} />
      )}
      {tab === 'composer' && <ComposerTab items={items} target={target} onSave={(it) => void upsert(it, target)} takenIds={idsIn(target)} />}
    </div>
  );
}

// ───────────── save location card (F7) ─────────────
function SaveLocationCard({ info, onClose, onShowInList, onLayoutAdd, onArchitecture, onPlace }: {
  info: SavedInfo; onClose: () => void; onShowInList: () => void; onLayoutAdd: () => void; onArchitecture: () => void; onPlace: () => void;
}) {
  const t = useT();
  const placeable = PLACEABLE.includes(info.category);
  const layer = info.layer === 'project' ? t('catalog.layer.project') : info.offline ? t('catalog.layer.libraryOffline') : t('catalog.layer.library');
  const Row = ({ icon, title, sub, action, onClick, disabled, data }: { icon: ReactNode; title: string; sub: string; action: string; onClick: () => void; disabled?: boolean; data: string }) => (
    <div className="row" style={{ gap: 10, padding: '6px 0', borderTop: '1px solid var(--border)' }}>
      <span style={{ color: 'var(--accent)', display: 'flex' }}>{icon}</span>
      <div className="grow" style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 12.5 }}>{title}</div>
        <div className="hint" style={{ margin: 0 }}>{sub}</div>
      </div>
      <button className="btn sm" disabled={disabled} onClick={onClick} data-save-action={data}>{action}</button>
    </div>
  );
  return (
    <div className="card" data-save-location style={{ marginTop: 10, borderColor: 'var(--accent)', background: 'linear-gradient(0deg, var(--surface-1), var(--surface-1)), var(--accent-soft)' }}>
      <div className="row" style={{ gap: 8 }}>
        <Icon name="check" size={16} style={{ color: 'var(--good)' }} />
        <strong>{t('catalog.save.title')}</strong>
        <span className="badge">{layer}</span>
        <span className="grow" />
        <button className="btn ghost sm" onClick={onClose} aria-label={t('catalog.save.close')}>✕</button>
      </div>
      <p className="secondary" style={{ margin: '6px 0 8px' }}>
        {t(info.layer === 'project' ? 'catalog.save.whereProject' : 'catalog.save.whereLibrary', { name: info.name, id: info.id })}
      </p>
      <Row data="list" icon={<Icon name="catalog" size={15} />} title={t('catalog.save.listTitle')} sub={t('catalog.save.listSub', { layer: t(`catalog.origin.${info.layer}`) })} action={t('catalog.save.listAction')} onClick={onShowInList} />
      <Row data="layout-add" icon={<Icon name="layout" size={15} />} title={t('catalog.save.addTitle')} sub={placeable ? t('catalog.save.addSub') : t('catalog.save.addSubNo', { category: t(`catalog.cat.${info.category}`) })} action={t('catalog.save.addAction')} onClick={onLayoutAdd} disabled={!placeable} />
      {info.category === 'gpu-rack' && (
        <Row data="architecture" icon={<Icon name="architecture" size={15} />} title={t('catalog.save.genTitle')} sub={t('catalog.save.genSub')} action={t('catalog.save.genAction')} onClick={onArchitecture} />
      )}
      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        <button className="btn primary" disabled={!placeable} onClick={onPlace} data-save-action="place"><Icon name="plus" size={14} />{t('catalog.save.place')}</button>
        {info.placed ? <span className="status" style={{ color: 'var(--good)' }}>{t('catalog.save.placed', { tag: info.placed.tag, hall: info.placed.hall })}</span> : <span className="hint" style={{ margin: 0 }}>{t('catalog.save.placeHint')}</span>}
      </div>
    </div>
  );
}

// ───────────── image ─────────────
function ItemImage({ item, size }: { item: CatalogItem; size: 'sm' | 'lg' }) {
  const t = useT();
  const img = catalogImage(item);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [img?.src]);
  if (!img) return null;
  // a missing thumbnail file degrades to the schematic
  const shown = failed && img.kind === 'thumbnail' ? catalogImage({ ...item, asset: undefined, image: undefined })! : img;
  if (size === 'sm') {
    return <img src={shown.src} alt="" loading="lazy" onError={() => setFailed(true)} data-image-kind={shown.kind} style={{ width: 34, height: 34, objectFit: 'contain', background: 'var(--surface-2)', borderRadius: 4, display: 'block' }} />;
  }
  return (
    <figure style={{ margin: '0 0 10px', display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <div style={{ position: 'relative', flex: '0 0 220px' }}>
        <img src={shown.src} alt={item.name} onError={() => setFailed(true)} data-image-kind={shown.kind} style={{ width: 220, height: 260, objectFit: 'contain', background: '#1b1f24', borderRadius: 8, border: '1px solid var(--border)', display: 'block' }} />
        <span className="badge" data-image-badge={shown.kind} style={{ position: 'absolute', left: 8, top: 8, background: shown.kind === 'schematic' ? 'rgba(201,133,0,0.9)' : shown.kind === 'user' ? 'rgba(25,158,112,0.9)' : 'rgba(57,135,229,0.9)', color: '#fff' }}>{t(`catalog.image.kind.${shown.kind}`)}</span>
      </div>
      <figcaption className="hint" style={{ margin: 0, fontSize: 11.5 }}>
        <div>{t(`catalog.image.credit.${shown.kind}`)}</div>
        {shown.credit && <div className="mono" style={{ marginTop: 2 }}>{shown.credit}</div>}
        <div style={{ marginTop: 6 }}>{t('catalog.image.noPhotos')}</div>
      </figcaption>
    </figure>
  );
}

// ───────────── items tab ─────────────
function ItemsTab({ items, selected, onSelect, draft, setDraft, onClone, onNew, onDelete, onSave, target, takenIds, project, origin, setOrigin, onConfigure }: {
  items: CatalogItem[]; selected: CatalogItem | null; onSelect: (id: string | null) => void;
  draft: CatalogItem | null; setDraft: (d: CatalogItem | null) => void;
  onClone: (it: CatalogItem) => void; onNew: () => void; onDelete: (it: CatalogItem) => void; onSave: (it: CatalogItem) => void;
  target: Target; takenIds: (exceptId?: string) => Set<string>; project: { equipment: { catalogId: string }[] };
  origin: Origin | 'all'; setOrigin: (o: Origin | 'all') => void;
  onConfigure: (it: Pick<CatalogItem, 'id'>) => void;
}) {
  const t = useT();
  const [cat, setCat] = useState<EquipmentCategory | 'all'>('all');
  const [vendor, setVendor] = useState('all');
  const [source, setSource] = useState<SpecSource | 'all'>('all');
  const [q, setQ] = useState('');
  const [stdFilter, setStdFilter] = useState<StandardsFilter>({});
  const projectDrafts = useApp((s) => s.project.standards?.includeDraftSpecs ?? false);
  const [draftsToggle, setDraftsToggle] = useState<boolean | null>(null);
  const drafts = draftsToggle ?? projectDrafts;
  const vendors = useMemo(() => [...new Set(items.map((i) => i.vendor))].sort(), [items]);
  const hiddenDrafts = useMemo(() => items.filter((i) => draftHidden(i, drafts)).length, [items, drafts]);
  const filtered = useMemo(() => items.filter((i) =>
    (cat === 'all' || i.category === cat) && (vendor === 'all' || i.vendor === vendor) && (source === 'all' || i.source === source)
    && (origin === 'all' || (i.origin ?? 'builtin') === origin)
    && matchesStandardsFilter(i, stdFilter) && !draftHidden(i, drafts)
    && (!q || `${i.id} ${i.name} ${i.model} ${i.vendor} ${i.description}`.toLowerCase().includes(q.toLowerCase()))), [items, cat, vendor, source, origin, q, stdFilter, drafts]);
  const facetLabel = (f: StandardsFacet) => t(f === 'rackPower' ? 'standards.ui.cat.rackPower' : f === 'level' ? 'standards.ui.cat.level' : f === 'specStatus' ? 'standards.ui.cat.specStatus' : f === 'verification' ? 'standards.ui.cat.verification' : `standards.ui.field.${f}`);
  const usedCount = (id: string) => project.equipment.filter((e) => e.catalogId === id).length;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(420px, 1fr) minmax(460px, 1fr)', gap: 14, alignItems: 'start' }}>
      <div>
        <Section title={t('catalog.filter.title')} actions={<button className="btn sm" onClick={onNew}><Icon name="plus" size={13} />{t('catalog.newItem')}</button>}>
          <div className="row wrap" style={{ gap: 6 }}>
            <div style={{ flex: '1 1 140px' }}><Select value={cat} options={[{ value: 'all' as const, label: t('catalog.filter.categoryAll') }, ...categoryOptions(t)]} onChange={setCat} /></div>
            <div style={{ flex: '1 1 140px' }}><Select value={vendor} options={[{ value: 'all', label: t('catalog.filter.vendorAll') }, ...vendors.map((v) => ({ value: v, label: v }))]} onChange={setVendor} /></div>
            <div style={{ flex: '1 1 120px' }}><Select value={source} options={[{ value: 'all' as const, label: t('catalog.filter.sourceAll') }, ...sourceOptions(t)]} onChange={setSource} /></div>
            <div style={{ flex: '1 1 120px' }} data-origin-filter={origin}><Select value={origin} options={[{ value: 'all' as const, label: t('catalog.filter.originAll') }, ...ORIGINS.map((o) => ({ value: o, label: originLabel(t, o) }))]} onChange={setOrigin} /></div>
            <div style={{ flex: '2 1 160px' }}><input type="text" placeholder={t('catalog.filter.search')} value={q} onChange={(e) => setQ(e.target.value)} /></div>
          </div>
          <div className="row wrap" style={{ gap: 6, marginTop: 6, alignItems: 'center' }} data-standards-filters>
            <span className="secondary" style={{ fontSize: 12, flex: '0 0 auto' }}>{t('standards.ui.cat.filters')}</span>
            {STANDARDS_FACETS.map((f) => (
              <div key={f} style={{ flex: '1 1 150px' }} data-std-facet={f}>
                <Select value={stdFilter[f] ?? 'all'} options={[{ value: 'all', label: t('standards.ui.cat.all', { field: facetLabel(f) }) }, ...facetValues(items, f).map((v) => ({ value: v, label: t(`standards.${FACET_LABEL_KIND[f]}.${v}`) }))]} onChange={(v) => setStdFilter((s) => ({ ...s, [f]: v }))} />
              </div>
            ))}
            <span data-std-drafts={drafts ? 'on' : 'off'}><Toggle label={t('standards.ui.drafts')} checked={drafts} onChange={setDraftsToggle} /></span>
            {hiddenDrafts > 0 && <span className="hint" data-std-hidden-drafts={hiddenDrafts}>{t('standards.ui.cat.hiddenDrafts', { n: hiddenDrafts })}</span>}
          </div>
        </Section>
        <Section title={t('catalog.list.title', { n: filtered.length })}>
          <DataTable
            columns={[
              { key: 'img', header: '', width: 42, render: (c: CatalogItem) => <ItemImage item={c} size="sm" /> },
              { key: 'cat', header: t('catalog.col.category'), render: (c: CatalogItem) => catLabel(t, c.category), sortValue: (c) => c.category },
              { key: 'vendor', header: t('catalog.col.vendor'), render: (c) => c.vendor, sortValue: (c) => c.vendor },
              { key: 'name', header: t('catalog.col.model'), render: (c) => <span title={c.id}>{c.name}</span>, sortValue: (c) => c.name },
              { key: 'kw', header: 'kW', num: true, render: (c) => (c.power ? c.power.nameplateKW.toFixed(1) : '—'), sortValue: (c) => c.power?.nameplateKW ?? 0 },
              { key: 'gpus', header: 'GPU', num: true, render: (c) => (c.compute?.gpus ? fmtInt(c.compute.gpus) : '—'), sortValue: (c) => c.compute?.gpus ?? 0 },
              { key: 'src', header: t('catalog.col.source'), render: (c) => <SourceBadge source={c.source} /> },
              { key: 'std', header: t('standards.ui.cat.col'), render: (c) => <StdChips item={c} compact /> },
              { key: 'origin', header: t('catalog.col.origin'), render: (c) => <span className="badge">{originLabel(t, c.origin ?? 'builtin')}</span>, sortValue: (c) => c.origin ?? 'builtin' },
            ]}
            rows={filtered}
            rowKey={(c) => c.id}
            selectedKeys={selected ? [selected.id] : []}
            onRowClick={(c) => onSelect(c.id)}
            maxHeight={620}
          />
        </Section>
      </div>
      <div>
        {draft ? (
          <ItemEditor draft={draft} setDraft={setDraft} onCancel={() => setDraft(null)} onSave={onSave} target={target} takenIds={takenIds(selected && selected.origin === target && selected.id === draft.id ? draft.id : undefined)} />
        ) : selected ? (
          <ItemDetail item={selected} used={usedCount(selected.id)} onClone={() => onClone(selected)} onEdit={() => setDraft(structuredClone(selected))} onDelete={() => onDelete(selected)} onConfigure={() => onConfigure(selected)} target={target} />
        ) : (
          <Section title={t('catalog.detail.title')}><Empty>{t('catalog.detail.empty', { layer: originLabel(t, target) })}</Empty></Section>
        )}
      </div>
    </div>
  );
}

function KV({ k, v }: { k: string; v: ReactNode }) {
  return <div className="row" style={{ gap: 8, padding: '2px 0' }}><span className="secondary" style={{ minWidth: 130, fontSize: 12 }}>{k}</span><span className="nowrap">{v}</span></div>;
}

function MfuBasisTable({ item }: { item: CatalogItem }) {
  const t = useT();
  const b = mfuBasisFor(item);
  if (!b) return null;
  return (
    <div style={{ marginTop: 10 }} data-mfu-basis>
      <div className="secondary" style={{ fontSize: 12, marginBottom: 4 }}>{t('catalog.mfu.title')}</div>
      <table className="data" style={{ fontSize: 11.5 }}>
        <thead><tr><th>{t('catalog.mfu.precision')}</th><th className="num">{t('catalog.mfu.peak')}</th><th>{t('catalog.mfu.sourceType')}</th><th>{t('catalog.mfu.citation')}</th></tr></thead>
        <tbody>
          {MFU_PRECISIONS.map((p) => {
            const e = b.basis[p];
            return (
              <tr key={p}>
                <td title={MFU_BASIS[p].definition}>{MFU_BASIS[p].label}</td>
                <td className="num">{e.value != null ? fmtInt(e.value) : '—'}</td>
                <td><span className={`badge ${e.sourceType === 'unpublished' ? 'warn' : ''}`}>{t(`catalog.evidence.${e.sourceType}`)}</span></td>
                <td style={{ whiteSpace: 'normal' }}>{e.citation}{e.url && <> · <a href={e.url} target="_blank" rel="noreferrer">link</a></>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="hint" style={{ margin: '4px 0 0' }}>{t('catalog.mfu.note')}</p>
    </div>
  );
}

/** Text-only standards chips (proposal §6.2): implementation level, draft spec, estimate / unverified. `compact` = list column. */
function StdChips({ item, compact }: { item: CatalogItem; compact?: boolean }) {
  const locale = useApp((s) => s.uiLocale);
  const chips = itemStandardsChips(item, locale).filter((c) => !compact || c.kind === 'level' || c.kind === 'draft');
  if (!chips.length) return compact ? <span className="muted">—</span> : null;
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }} data-std-chips>
      {chips.map((c, i) => <span key={i} className={`badge ${c.kind === 'draft' ? 'warn' : c.kind === 'level' ? 'std-level' : ''}`} title={c.tooltip} data-std-chip={c.kind}>{c.text}</span>)}
    </span>
  );
}

/** Item detail "Standards" table (document, version, date, status, licence, level, scope, verification, link) and per-field provenance. */
function StandardsDetail({ item }: { item: CatalogItem }) {
  const t = useT();
  const entries = item.standards ?? [];
  const prov = Object.entries(item.paramSources ?? {});
  const draftish = (s: string) => s === 'draft' || s === 'review' || s === 'roadmap';
  return (
    <div style={{ marginTop: 10 }} data-item-standards={entries.length}>
      <div className="secondary" style={{ fontSize: 12, marginBottom: 4 }}>{t('standards.ui.cat.detail')}</div>
      {!entries.length ? <p className="hint" style={{ margin: 0 }}>{t('standards.ui.cat.none')}</p> : (
        <div style={{ overflowX: 'auto' }}>
          <table className="data" style={{ fontSize: 11.5 }}>
            <thead><tr><th>{t('standards.ui.col.document')}</th><th>{t('standards.ui.col.version')}</th><th>{t('standards.ui.col.date')}</th><th>{t('standards.ui.col.status')}</th><th>{t('standards.ui.col.licence')}</th><th>{t('standards.ui.cat.col.level')}</th><th>{t('standards.ui.cat.col.scope')}</th><th>{t('standards.ui.cat.col.verification')}</th><th>{t('standards.ui.col.link')}</th></tr></thead>
            <tbody>
              {entries.map((s, i) => {
                const ref = findStandard(s.standardId);
                return (
                  <tr key={i}>
                    <td style={{ whiteSpace: 'normal', minWidth: 160 }}>
                      {ref?.title ?? t('standards.ui.cat.noStandard')}
                      {s.note && <div className="hint">{s.note}</div>}
                      {s.evidence && <div className="hint">{t('standards.ui.cat.evidence')}: <a href={s.evidence.url} target="_blank" rel="noreferrer">{s.evidence.label}</a></div>}
                    </td>
                    <td>{ref?.version ?? '—'}</td>
                    <td>{ref?.date || '—'}</td>
                    <td>{ref ? <span className={`badge ${draftish(ref.status) ? 'warn' : ''}`}>{t(`standards.status.${ref.status}`)}</span> : '—'}</td>
                    <td>{ref ? t(`standards.licence.${ref.licence}`) : '—'}</td>
                    <td>{t(`standards.level.${s.level}`)}</td>
                    <td>{t(`standards.scope.${s.scope}`)}</td>
                    <td>{t(`standards.verification.${s.verification}`)}</td>
                    <td>{ref?.url ? <a href={ref.url} target="_blank" rel="noreferrer">{t('standards.ui.link')}</a> : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {prov.length > 0 && (
        <details style={{ marginTop: 6 }} data-item-provenance={prov.length}>
          <summary className="secondary" style={{ cursor: 'pointer', fontSize: 12 }}>{t('standards.ui.cat.provenance')} ({prov.length})</summary>
          <div style={{ overflowX: 'auto' }}>
            <table className="data" style={{ fontSize: 11.5 }}>
              <thead><tr><th>{t('standards.ui.cat.col.field')}</th><th>{t('standards.ui.col.document')}</th><th>{t('standards.ui.cat.col.clause')}</th><th>{t('standards.ui.cat.col.verification')}</th><th>{t('standards.ui.cat.col.note')}</th></tr></thead>
              <tbody>
                {prov.map(([k, v]) => (
                  <tr key={k}>
                    <td className="mono">{k}</td>
                    <td style={{ whiteSpace: 'normal' }}>{v.standardId ? standardCitation(v.standardId) : '—'}</td>
                    <td>{v.clause ?? '—'}</td>
                    <td>{t(`standards.verification.${v.verification}`)}</td>
                    <td style={{ whiteSpace: 'normal' }}>{v.note ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}

function ItemDetail({ item, used, onClone, onEdit, onDelete, onConfigure, target }: { item: CatalogItem; used: number; onClone: () => void; onEdit: () => void; onDelete: () => void; onConfigure: () => void; target: Target }) {
  const t = useT();
  const origin = item.origin ?? 'builtin';
  const editable = origin !== 'builtin';
  const c = item.compute;
  const umap = item.meta?.umap as UMapEntry[] | undefined;
  const isRack = /-rack$/.test(item.category);
  const ratings = item.meta?.ratings as { coolingKW: number; atdC: number; flowLpm?: number; headPsi?: number; note?: string }[] | undefined;
  return (
    <Section
      title={t('catalog.detail.title')}
      actions={
        <>
          {item.category === 'gpu-rack' && <button className="btn primary sm" onClick={onConfigure} title={t('catalog.detail.configurePlatformTitle')}><Icon name="architecture" size={13} />{t('catalog.detail.configurePlatform')}</button>}
          <button className="btn sm" onClick={onClone} title={t('catalog.detail.cloneTooltip', { layer: originLabel(t, target) })}><Icon name="copy" size={13} />{t('catalog.detail.clone')}</button>
          {editable && <button className="btn sm" onClick={onEdit}>{t('catalog.detail.edit')}</button>}
          {editable && <button className="btn danger sm" onClick={onDelete} title={t('catalog.detail.deleteTooltip')}><Icon name="trash" size={13} /></button>}
        </>
      }
    >
      <div className="card" data-item-detail={item.id}>
        <div className="row wrap" style={{ gap: 6, marginBottom: 6 }}>
          <h3 style={{ margin: 0 }}>{item.name}</h3>
          <span className="grow" />
          <SourceBadge source={item.source} />
          <StdChips item={item} />
          {/* stream T4 (#5): meta.specStatus = 'announced' on an item whose source tag is not already 'announced' */}
          {announcedSpec(item).announced && item.source !== 'announced' && <span className="badge warn" data-announced-badge title={t('catalog.badge.announcedTip', { fields: announcedSpec(item).fields.join('; ') || '—' })}>{t('catalog.badge.announced')}</span>}
          <span className="badge">{originLabel(t, origin)}</span>
          <span className="badge">{catLabel(t, item.category)}</span>
          {!PLACEABLE.includes(item.category) && <span className="badge" title={t('catalog.detail.notPlaceableTooltip')}>{t('catalog.detail.notPlaceable')}</span>}
        </div>
        <div className="muted mono" style={{ fontSize: 11.5, marginBottom: 8 }}>{item.id} · {item.vendor} · {item.model}{used ? ` · ${t('catalog.detail.placedCount', { n: used })}` : ''}</div>
        <ItemImage item={item} size="lg" />
        <p className="secondary" style={{ margin: '8px 0' }}>{item.description}</p>
        {announcedSpec(item).fields.length > 0 && <p className="small muted" style={{ margin: '0 0 8px' }} data-announced-fields>{t('catalog.detail.announcedFields', { fields: announcedSpec(item).fields.join('; ') })}</p>}
        <div className="grid-3">
          {item.power && <Stat label={t('catalog.stat.power')} value={`${item.power.nameplateKW.toFixed(1)} kW`} delta={t('catalog.stat.powerDelta', { typical: item.power.typicalKW.toFixed(1), peak: item.power.peakKW.toFixed(1) })} />}
          <Stat label={t('catalog.stat.dims')} value={`${item.dims.w} × ${item.dims.d} × ${item.dims.h} m`} delta={`${fmtInt(item.weightKg)} kg${item.rackUnits ? ` · ${item.rackUnits}U` : ''}`} />
          {item.cooling && <Stat label={t('catalog.stat.cooling')} value={item.cooling.liquidFraction > 0 ? t('catalog.stat.liquid', { pct: Math.round(item.cooling.liquidFraction * 100) }) : t('catalog.stat.air')} delta={`${item.cooling.airflowM3s} m³/s · ${item.cooling.liquidFlowLpm} LPM · ≤ ${item.cooling.maxInletC} °C${item.cooling.maxCoolantSupplyC ? ` · ${t('catalog.stat.coolant', { c: item.cooling.maxCoolantSupplyC })}` : ''}`} />}
          {c && c.gpus > 0 && <Stat label={t('catalog.stat.accel')} value={`${c.gpus} × ${c.gpuModel}`} delta={`${c.gpuMemoryGB} GB · ${c.memBandwidthGBps ? `${fmtInt(c.memBandwidthGBps)} GB/s` : '—'} · ${t('catalog.stat.nodesXgpus', { nodes: c.nodesPerRack ?? '?', gpus: c.gpusPerNode ?? '?' })}`} />}
          {c?.scaleUp && <Stat label={t('catalog.stat.scaleUp')} value={`${c.scaleUp.family || c.scaleUp.kind} × ${c.scaleUp.domainSize}`} delta={`${fmtInt(c.scaleUp.gbpsPerGpu)} Gb/s/GPU · ${t('catalog.stat.rails', { n: c.railsPerNode ?? '—' })}`} />}
          {c && c.scaleOutPortGbps > 0 && <Stat label={t('catalog.stat.scaleOut')} value={`${c.scaleOutPortsPerGpu} × ${c.scaleOutPortGbps}G / GPU`} delta={`FE ${c.frontendPorts} × ${c.frontendPortGbps}G · ST ${c.storagePorts} × ${c.storagePortGbps}G · OOB ${c.oobPorts}`} />}
          {item.switch && <Stat label={t('catalog.stat.switch')} value={`${item.switch.ports} × ${item.switch.portGbps}G`} delta={`${item.switch.fabric} · ${item.switch.rackUnits}U · ${item.switch.role}${item.switch.netPorts ? ` · net ${item.switch.netPorts} / fabric ${item.switch.fabricPorts}` : ''}`} />}
          {item.nic && <Stat label="NIC" value={`${item.nic.ports} × ${item.nic.portGbps}G`} delta={`${item.nic.formFactor} · ${item.nic.hostInterface} · ${item.nic.transports.join('/')} · ${item.nic.wattsTypical}/${item.nic.wattsMax} W`} />}
          {item.capacity?.coolingKW != null && <Stat label={t('catalog.stat.coolingCap')} value={`${fmtInt(item.capacity.coolingKW)} kW`} delta={`${item.capacity.liquidFlowLpm ? `${fmtInt(item.capacity.liquidFlowLpm)} LPM` : ''}${item.capacity.airflowM3s ? ` ${item.capacity.airflowM3s.toFixed(1)} m³/s` : ''}`} />}
          {item.capacity?.powerKVA != null && <Stat label={t('catalog.stat.powerCap')} value={`${fmtInt(item.capacity.powerKVA)} kVA`} delta={`${item.capacity.currentA ? `${item.capacity.currentA} A · ` : ''}${item.capacity.outputVoltageV ?? ''} V`} />}
          <Stat label="CAPEX" value={`$${fmtInt(item.cost.capexUSD)}`} delta={t('catalog.stat.capexDelta', { h: item.cost.installHours, wk: item.cost.leadTimeWeeks })} />
        </div>
        {c && c.gpus > 0 && <MfuBasisTable item={item} />}
        <StandardsDetail item={item} />
        {ratings && ratings.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div className="secondary" style={{ fontSize: 12, marginBottom: 4 }}>{t('catalog.detail.ratings')}</div>
            {ratings.map((r, i) => <KV key={i} k={`${fmtInt(r.coolingKW)} kW @ ${r.atdC} °C ATD`} v={`${r.flowLpm ? `${fmtInt(r.flowLpm)} LPM` : ''}${r.headPsi ? ` · ${r.headPsi} psi` : ''}${r.note ? ` · ${r.note}` : ''}`} />)}
          </div>
        )}
        {item.links && item.links.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div className="secondary" style={{ fontSize: 12, marginBottom: 4 }}>{t('catalog.detail.links')}</div>
            {item.links.map((l, i) => <div key={i}><a href={l.url} target="_blank" rel="noreferrer">{l.label}</a> <span className="muted mono" style={{ fontSize: 11 }}>{l.url}</span></div>)}
          </div>
        )}
        {item.notes && <p className="hint" style={{ marginTop: 10 }}>{item.notes}</p>}
        {isRack && (
          <div style={{ marginTop: 10 }}>
            <div className="secondary" style={{ fontSize: 12, marginBottom: 4 }}>
              {umap ? t('catalog.detail.umapComposed', { used: String(item.meta?.ruUsed), cap: String(item.meta?.ruCap), kw: String(item.meta?.kwCap), src: String(item.meta?.kwCapSource) }) : t('catalog.detail.umapPlanning')}
            </div>
            <div style={{ overflowX: 'auto' }}><RackBlueprint item={item} /></div>
          </div>
        )}
        <details style={{ marginTop: 10 }}>
          <summary className="secondary" style={{ cursor: 'pointer', fontSize: 12 }}>JSON</summary>
          <pre className="mono" style={{ fontSize: 11, maxHeight: 260, overflow: 'auto', background: 'var(--surface-2)', padding: 8, borderRadius: 6 }}>{JSON.stringify(stripOrigin({ ...item, ...(item.image?.dataUrl ? { image: { ...item.image, dataUrl: `${item.image.dataUrl.slice(0, 48)}…` } } : {}) }), null, 2)}</pre>
        </details>
      </div>
    </Section>
  );
}

// ───────────── editor ─────────────
function ImageUploadField({ draft, setDraft }: { draft: CatalogItem; setDraft: (d: CatalogItem) => void }) {
  const t = useT();
  const ref = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const onFile = (file: File) => {
    setErr(null);
    if (!IMAGE_TYPES.includes(file.type)) return setErr(t('catalog.image.badType'));
    if (file.size > CATALOG_IMAGE_MAX_BYTES) return setErr(t('catalog.image.tooBig', { kb: Math.round(file.size / 1024) }));
    const reader = new FileReader();
    reader.onload = () => setDraft({ ...draft, image: { kind: 'user', dataUrl: String(reader.result), credit: file.name.slice(0, 120) } });
    reader.onerror = () => setErr(t('catalog.image.readError'));
    reader.readAsDataURL(file);
  };
  const img = catalogImage(draft);
  return (
    <Field label={t('catalog.image.upload')} hint={t('catalog.image.uploadHint')}>
      <div className="row" style={{ gap: 10, alignItems: 'center' }}>
        {img && <img src={img.src} alt="" style={{ width: 64, height: 64, objectFit: 'contain', background: '#1b1f24', borderRadius: 6, border: '1px solid var(--border)' }} />}
        <div>
          <span className="badge">{img ? t(`catalog.image.kind.${img.kind}`) : '—'}</span>
          <div className="row" style={{ gap: 6, marginTop: 4 }}>
            <button className="btn sm" type="button" onClick={() => ref.current?.click()}><Icon name="upload" size={13} />{t('catalog.image.choose')}</button>
            {draft.image?.kind === 'user' && <button className="btn ghost sm" type="button" onClick={() => { const { image: _i, ...rest } = draft; setDraft(rest as CatalogItem); }}>{t('catalog.image.remove')}</button>}
          </div>
          {err && <div className="status error">{err}</div>}
        </div>
        <input ref={ref} type="file" accept={IMAGE_TYPES.join(',')} hidden data-image-input onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
      </div>
    </Field>
  );
}

function ItemEditor({ draft, setDraft, onCancel, onSave, target, takenIds }: { draft: CatalogItem; setDraft: (d: CatalogItem) => void; onCancel: () => void; onSave: (it: CatalogItem) => void; target: Target; takenIds: Set<string> }) {
  const t = useT();
  const errors = validateCatalogItem(draft, takenIds, t);
  const [jsonText, setJsonText] = useState<string | null>(null);
  const [jsonErr, setJsonErr] = useState<string | null>(null);
  const setNum = (path: string, v: number) => setDraft(setPath(draft, path, v));
  const setStr = (path: string, v: string) => setDraft(setPath(draft, path, v));
  const has = (key: string) => (draft as unknown as Record<string, unknown>)[key] != null;
  const toggleBlock = (key: string, on: boolean) => {
    const next = structuredClone(draft) as unknown as Record<string, unknown>;
    if (on) next[key] = structuredClone(DEFAULT_BLOCK[key]);
    else delete next[key];
    setDraft(next as unknown as CatalogItem);
  };
  const linksText = (draft.links ?? []).map((l) => `${l.label} | ${l.url}`).join('\n');

  return (
    <Section title={t('catalog.editor.title', { layer: target === 'project' ? t('catalog.layer.project') : t('catalog.layer.library') })} actions={
      <>
        <button className="btn ghost sm" onClick={onCancel}>{t('catalog.editor.cancel')}</button>
        <button className="btn primary sm" disabled={errors.length > 0} onClick={() => onSave(draft)} title={errors.length ? errors.join('\n') : t('catalog.editor.save')} data-editor-save><Icon name="save" size={13} />{t('catalog.editor.save')}</button>
      </>
    }>
      <div className="card">
        {errors.length > 0 && (
          <div style={{ marginBottom: 8 }}>
            {errors.map((e, i) => <div key={i} className="status error" style={{ display: 'flex' }}><Icon name="error" size={13} /> {e}</div>)}
          </div>
        )}
        <div className="fields-2">
          <div>
            <TextField label="ID" value={draft.id} onChange={(v) => setStr('id', v.trim())} hint={t('catalog.editor.idHint')} />
            <TextField label={t('catalog.editor.name')} value={draft.name} onChange={(v) => setStr('name', v)} />
            <TextField label={t('catalog.col.vendor')} value={draft.vendor} onChange={(v) => setStr('vendor', v)} />
            <TextField label={t('catalog.col.model')} value={draft.model} onChange={(v) => setStr('model', v)} />
          </div>
          <div>
            <SelectField label={t('catalog.col.category')} value={draft.category} options={categoryOptions(t)} onChange={(v) => setDraft({ ...draft, category: v })} />
            <SelectField label={t('catalog.col.source')} value={draft.source} options={sourceOptions(t)} onChange={(v) => setDraft({ ...draft, source: v })} hint={t('catalog.editor.sourceHint')} />
            {draft.compute && <TextField label={t('catalog.editor.gpuModel')} value={draft.compute.gpuModel} onChange={(v) => setStr('compute.gpuModel', v)} />}
            {draft.compute && <TextField label={t('catalog.editor.cpuModel')} value={draft.compute.cpuModel} onChange={(v) => setStr('compute.cpuModel', v)} />}
            {draft.compute && <SelectField label={t('catalog.editor.scaleUpKind')} value={draft.compute.scaleUp.kind} options={(['nvlink', 'ualink', 'esun-ethernet', 'vendor-proprietary', 'pcie', 'none'] as const).map((v) => ({ value: v, label: v }))} onChange={(v) => setDraft(setPath(draft, 'compute.scaleUp.kind', v))} hint={t('catalog.editor.scaleUpKindHint')} />}
            {draft.compute && <TextField label={t('catalog.editor.scaleUpFamily')} value={draft.compute.scaleUp.family ?? ''} onChange={(v) => setDraft(setPath(draft, 'compute.scaleUp.family', v.trim() || undefined))} hint={t('catalog.editor.scaleUpFamilyHint')} />}
            {draft.compute && <Toggle label={t('catalog.editor.scaleUpSpansRacks')} checked={draft.compute.scaleUp.spansRacks === true} onChange={(v) => setDraft(setPath(draft, 'compute.scaleUp.spansRacks', v))} />}
            {draft.switch && <TextField label={t('catalog.editor.fabric')} value={draft.switch.fabric} onChange={(v) => setStr('switch.fabric', v)} hint="ib-xdr-800 · ib-ndr-400 · spectrumx-800 · spectrumx-400 · roce-generic-400 · roce-generic-800 · drivenets-fse · ese-uec-400 · ethernet-400 …" />}
            {draft.switch && <SelectField label={t('catalog.editor.switchRole')} value={draft.switch.role} options={(['any', 'leaf', 'spine', 'core', 'mgmt'] as const).map((r) => ({ value: r, label: r }))} onChange={(v) => setDraft(setPath(draft, 'switch.role', v))} />}
            <TextField label={t('catalog.editor.color')} value={draft.asset?.color ?? '#3a3f44'} onChange={(v) => setStr('asset.color', v)} />
          </div>
        </div>
        <ImageUploadField draft={draft} setDraft={setDraft} />
        <Field label={t('catalog.editor.description')}><textarea rows={2} value={draft.description} onChange={(e) => setStr('description', e.target.value)} /></Field>
        {FORM_GROUPS.map((g) => {
          const on = g.key === 'base' || has(g.key as string);
          return (
            <div key={g.key} style={{ marginTop: 8 }}>
              <div className="row" style={{ marginBottom: 2 }}>
                <span className="secondary" style={{ fontSize: 12, fontWeight: 600 }}>{t(`catalog.group.${g.key}`)}</span>
                <span className="grow" />
                {g.optional && <Toggle label={on ? t('catalog.editor.included') : t('catalog.editor.none')} checked={on} onChange={(v) => toggleBlock(g.key as string, v)} />}
              </div>
              {on && (
                <div className="fields-2">
                  <div>{g.fields.filter((_, i) => i % 2 === 0).map((fl) => <NumberField key={fl.path} label={t(`catalog.field.${fl.key}`)} unit={fl.unit} step={fl.step} min={fl.min} value={Number(getPath(draft, fl.path) ?? 0)} onChange={(v) => setNum(fl.path, v)} />)}</div>
                  <div>{g.fields.filter((_, i) => i % 2 === 1).map((fl) => <NumberField key={fl.path} label={t(`catalog.field.${fl.key}`)} unit={fl.unit} step={fl.step} min={fl.min} value={Number(getPath(draft, fl.path) ?? 0)} onChange={(v) => setNum(fl.path, v)} />)}</div>
                </div>
              )}
            </div>
          );
        })}
        <Field label={t('catalog.editor.links')}><textarea rows={2} defaultValue={linksText} onBlur={(e) => setDraft({ ...draft, links: e.target.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [label, url] = l.split('|').map((s) => s.trim()); return { label: label || url, url: url || label }; }) })} /></Field>
        <Field label={t('catalog.editor.notes')}><textarea rows={3} value={draft.notes ?? ''} onChange={(e) => setStr('notes', e.target.value)} /></Field>
        <details style={{ marginTop: 8 }} onToggle={(e) => { if ((e.target as HTMLDetailsElement).open) { setJsonText(JSON.stringify(stripOrigin(draft), null, 2)); setJsonErr(null); } }}>
          <summary className="secondary" style={{ cursor: 'pointer', fontSize: 12 }}>{t('catalog.editor.advancedJson')}</summary>
          {jsonText != null && (
            <div>
              <textarea rows={14} value={jsonText} onChange={(e) => setJsonText(e.target.value)} style={{ fontSize: 11 }} />
              <div className="row" style={{ marginTop: 4 }}>
                <button className="btn sm" onClick={() => { try { const v = JSON.parse(jsonText) as CatalogItem; setDraft(v); setJsonErr(null); } catch (err) { setJsonErr((err as Error).message); } }}>{t('catalog.editor.applyJson')}</button>
                {jsonErr && <span className="status error">{jsonErr}</span>}
              </div>
            </div>
          )}
        </details>
      </div>
    </Section>
  );
}

// ───────────── cables tab ─────────────
const CABLE_KINDS: CableType['kind'][] = ['dac', 'acc', 'aec', 'aoc', 'mmf', 'smf', 'cat6a', 'power'];

function validateCable(c: CableType, t: T): string[] {
  const e: string[] = [];
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  if (!ID_RE.test(c.id ?? '')) e.push(t('catalog.cable.val.id'));
  if (!c.name?.trim()) e.push(t('catalog.cable.val.name'));
  if (!CABLE_KINDS.includes(c.kind)) e.push('kind');
  for (const k of ['gbps', 'maxReachM', 'minReachM', 'cableUSD', 'cableUSDPerM', 'transceiverUSD', 'transceiverW', 'latencyNsPerM'] as const) if (!num(c[k])) e.push(t('catalog.cable.val.number', { field: k }));
  if (num(c.minReachM) && num(c.maxReachM) && c.minReachM > c.maxReachM) e.push('minReachM > maxReachM');
  if (!SOURCES.includes(c.source)) e.push(t('catalog.val.source'));
  return e;
}

function CablesTab({ cables, target, draft, setDraft, project, update, saveLibrary, notify }: {
  cables: CableType[]; target: Target; draft: string | null; setDraft: (s: string | null) => void;
  project: { cableExtensions?: CableType[] }; update: (m: (d: { cableExtensions?: CableType[] }) => void) => void;
  saveLibrary: (lib: CatalogLibrary) => Promise<void>; notify: (t: string, k?: 'info' | 'error' | 'ok') => void;
}) {
  const t = useT();
  void project;
  const [selId, setSelId] = useState<string | null>(null);
  const sel = cables.find((c) => c.id === selId) ?? null;
  const parsed = useMemo(() => { if (draft == null) return null; try { return { v: JSON.parse(draft) as CableType, err: null as string | null }; } catch (e) { return { v: null, err: (e as Error).message }; } }, [draft]);
  const errs = parsed?.v ? validateCable(parsed.v, t) : parsed?.err ? [parsed.err] : [];
  const kindLabel = (k: CableType['kind']) => t(`catalog.cable.kind.${k}`);
  const layerLabel = target === 'project' ? t('catalog.origin.project') : t('catalog.origin.library');
  const clone = (c: CableType) => {
    const { origin: _o, ...rest } = c;
    setDraft(JSON.stringify({ ...rest, id: `${c.id}-copy`, name: t('catalog.cloneName', { name: c.name }), source: 'user', medium: c.medium ?? (c.kind === 'smf' ? 'smf' : c.kind === 'mmf' ? 'mmf' : c.kind === 'aoc' ? 'aoc' : 'copper'), wattsPerEnd: c.wattsPerEnd ?? c.transceiverW, priceFixedUSD: c.priceFixedUSD ?? c.cableUSD, pricePerMUSD: c.pricePerMUSD ?? c.cableUSDPerM }, null, 2));
  };
  const save = async () => {
    if (!parsed?.v || errs.length) return;
    const c = parsed.v;
    // keep the engine fields in sync with the v2 aliases
    const norm: CableType = { ...c, transceiverW: c.wattsPerEnd ?? c.transceiverW, cableUSD: c.priceFixedUSD ?? c.cableUSD, cableUSDPerM: c.pricePerMUSD ?? c.cableUSDPerM };
    if (target === 'project') update((d) => { const ext = (d.cableExtensions ?? []).filter((x) => x.id !== norm.id); ext.push(norm); d.cableExtensions = ext; });
    else await saveLibrary({ items: (libraryCache.items ?? []).map(stripOrigin), cables: [...(libraryCache.cables ?? []).filter((x) => x.id !== norm.id).map(stripOrigin), norm] });
    notify(t('catalog.cable.saved', { name: norm.name, layer: layerLabel }), 'ok');
    setDraft(null);
    setSelId(norm.id);
  };
  const remove = async (c: CableType) => {
    if (c.origin === 'project') update((d) => { d.cableExtensions = (d.cableExtensions ?? []).filter((x) => x.id !== c.id); });
    else if (c.origin === 'library') await saveLibrary({ items: (libraryCache.items ?? []).map(stripOrigin), cables: (libraryCache.cables ?? []).filter((x) => x.id !== c.id).map(stripOrigin) });
    setSelId(null);
  };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(380px, 1fr) minmax(360px, 1fr)', gap: 14, alignItems: 'start' }}>
      <Section title={t('catalog.cable.listTitle', { n: cables.length })}>
        <DataTable
          columns={[
            { key: 'kind', header: t('catalog.cable.col.medium'), render: (c: CableType) => kindLabel(c.kind), sortValue: (c) => c.kind },
            { key: 'name', header: t('catalog.cable.col.name'), render: (c) => <span title={c.id}>{c.name}</span>, sortValue: (c) => c.name },
            { key: 'g', header: 'Gb/s', num: true, render: (c) => fmtInt(c.gbps), sortValue: (c) => c.gbps },
            { key: 'reach', header: t('catalog.cable.col.reach'), num: true, render: (c) => `${c.minReachM}–${c.maxReachM}`, sortValue: (c) => c.maxReachM },
            { key: 'w', header: 'W/end', num: true, render: (c) => (c.wattsPerEnd ?? c.transceiverW).toFixed(1), sortValue: (c) => c.wattsPerEnd ?? c.transceiverW },
            { key: 'usd', header: t('catalog.cable.col.price'), num: true, render: (c) => `$${fmtInt(c.priceFixedUSD ?? c.cableUSD)} + $${(c.pricePerMUSD ?? c.cableUSDPerM).toFixed(1)}${c.transceiverUSD ? ` · ${t('catalog.cable.optic')} $${fmtInt(c.transceiverUSD)}` : ''}`, sortValue: (c) => c.cableUSD },
            { key: 'src', header: t('catalog.col.source'), render: (c) => <SourceBadge source={c.source} /> },
            { key: 'origin', header: t('catalog.col.origin'), render: (c) => <span className="badge">{originLabel(t, c.origin ?? 'builtin')}</span> },
          ]}
          rows={cables}
          rowKey={(c) => c.id}
          selectedKeys={selId ? [selId] : []}
          onRowClick={(c) => { setSelId(c.id); setDraft(null); }}
          maxHeight={560}
          initialSort={{ key: 'g', dir: 1 }}
        />
        <p className="hint">{t('catalog.cable.engineHint')}</p>
      </Section>
      <Section title={draft != null ? t('catalog.cable.editTitle', { layer: layerLabel }) : t('catalog.detail.title')} actions={
        draft != null ? (
          <>
            <button className="btn ghost sm" onClick={() => setDraft(null)}>{t('catalog.editor.cancel')}</button>
            <button className="btn primary sm" disabled={errs.length > 0} onClick={() => void save()} title={errs.join('\n')}><Icon name="save" size={13} />{t('catalog.editor.save')}</button>
          </>
        ) : sel ? (
          <>
            <button className="btn sm" onClick={() => clone(sel)}><Icon name="copy" size={13} />{t('catalog.detail.clone')}</button>
            {sel.origin && sel.origin !== 'builtin' && <button className="btn sm" onClick={() => setDraft(JSON.stringify(stripOrigin(sel), null, 2))}>{t('catalog.detail.edit')}</button>}
            {sel.origin && sel.origin !== 'builtin' && <button className="btn danger sm" onClick={() => void remove(sel)}><Icon name="trash" size={13} /></button>}
          </>
        ) : null
      }>
        {draft != null ? (
          <div className="card">
            {errs.length > 0 && errs.map((e, i) => <div key={i} className="status error" style={{ display: 'flex' }}><Icon name="error" size={13} /> {e}</div>)}
            <textarea rows={22} value={draft} onChange={(e) => setDraft(e.target.value)} style={{ fontSize: 11.5, marginTop: 6 }} />
          </div>
        ) : sel ? (
          <div className="card">
            <div className="row wrap" style={{ gap: 6 }}><h3 style={{ margin: 0 }}>{sel.name}</h3><span className="grow" /><SourceBadge source={sel.source} /><span className="badge">{originLabel(t, sel.origin ?? 'builtin')}</span></div>
            <div className="muted mono" style={{ fontSize: 11.5 }}>{sel.id}</div>
            <div className="grid-3" style={{ marginTop: 8 }}>
              <Stat label={t('catalog.cable.speed')} value={`${fmtInt(sel.gbps)} Gb/s`} delta={`${kindLabel(sel.kind)} · ${sel.medium ?? '—'}`} />
              <Stat label={t('catalog.cable.reach')} value={`${sel.minReachM}–${sel.maxReachM} m`} delta={`${sel.latencyNsPerM} ns/m`} />
              <Stat label={t('catalog.cable.powerPerEnd')} value={`${(sel.wattsPerEnd ?? sel.transceiverW).toFixed(1)} W`} delta={sel.transceiverUSD ? `${t('catalog.cable.optic')} $${fmtInt(sel.transceiverUSD)}` : t('catalog.cable.integrated')} />
              <Stat label={t('catalog.cable.price')} value={`$${fmtInt(sel.priceFixedUSD ?? sel.cableUSD)}`} delta={`+ $${(sel.pricePerMUSD ?? sel.cableUSDPerM).toFixed(2)}/m`} />
            </div>
          </div>
        ) : (
          <Empty>{t('catalog.cable.empty')}</Empty>
        )}
      </Section>
    </div>
  );
}

// ───────────── composer tab (F7: fixed rack blueprint) ─────────────
interface SwitchRow { id: string; count: number }

function ComposerTab({ items, target, onSave, takenIds }: { items: CatalogItem[]; target: Target; onSave: (it: CatalogItem) => void; takenIds: Set<string> }) {
  const t = useT();
  const [nodeId, setNodeId] = useState(NODE_SPECS[0]?.id ?? '');
  const [n, setN] = useState(4);
  const [rackId, setRackId] = useState('rack-48u-600x1200');
  const [switchRows, setSwitchRows] = useState<SwitchRow[]>([]);
  const [shelves, setShelves] = useState({ count: 0, units: 1, ratingKW: 33 });
  const [blanks, setBlanks] = useState(0);
  const [positions, setPositions] = useState<Record<string, number>>({});
  const [selComp, setSelComp] = useState<string | null>(null);
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const node = findNodeSpec(nodeId);
  const rack = findRackModel(rackId);
  const switchItems = items.filter((i) => i.category === 'switch');
  const swObjs = switchRows.map((r) => ({ item: items.find((i) => i.id === r.id), count: Math.max(1, Math.round(r.count)) })).filter((x): x is { item: CatalogItem; count: number } => !!x.item);
  const swRU = swObjs.reduce((s, x) => s + (x.item.switch?.rackUnits ?? 1) * x.count, 0);
  const fit = node && rack ? maxNodesPerRack(node, rack, swRU + shelves.count * shelves.units + blanks) : null;
  const powerShelves = shelves.count > 0 ? { count: shelves.count, rackUnits: shelves.units, ratingKW: shelves.ratingKW } : undefined;

  const components = useMemo(() => (node ? rackComponentsFor({ node, nodesPerRack: n, switches: swObjs, powerShelves, blanks }) : []), [node, n, JSON.stringify(switchRows), shelves.count, shelves.units, shelves.ratingKW, blanks, items]); // eslint-disable-line react-hooks/exhaustive-deps
  const placement = useMemo(() => placeRackComponents(components, rack?.rackUnits ?? 48, positions), [components, rack, positions]);
  const result = useMemo(() => {
    if (!node || !rack) return { item: null, error: t('catalog.composer.pick') };
    if (placement.issues.length) return { item: null, error: t('catalog.composer.layoutInvalid') };
    try {
      const item = composeRack({ node, nodesPerRack: n, rackModel: rack, switches: swObjs, powerShelves, blanks, positions, id: id.trim() || undefined, name: name.trim() || undefined, source: 'user' });
      return { item, error: null };
    } catch (e) {
      return { item: null, error: (e as Error).message };
    }
  }, [node, rack, n, components, placement, positions, id, name]); // eslint-disable-line react-hooks/exhaustive-deps
  const item = result.item;
  const errors = item ? validateCatalogItem(item, takenIds, t) : [];
  const nodeOptions = NODE_SPECS.map((s) => ({ value: s.id, label: `${s.vendor} · ${s.name} — ${s.rackUnits}U · ${s.power.nameplateKW} kW · ${s.cooling.kind}` }));
  const entries: RackBlueprintEntry[] = placement.placed.filter((p) => p.u != null).map((p) => ({ u: p.u!, heightU: p.units, label: p.label, id: p.id, kind: p.kind, kw: p.kw, catalogId: p.ref, conflict: p.conflict }));
  const overflowU = placement.placed.filter((p) => p.u == null).reduce((s, p) => s + p.units, 0);
  const move = (cid: string, dir: 1 | -1) => { setPositions(moveRackComponent(components, rack?.rackUnits ?? 48, positions, cid, dir)); setSelComp(cid); };
  const unit = rack && rack.form !== 'eia-19' ? 'OU' : 'U';
  const itKW = components.reduce((s, c) => s + (c.kw ?? 0), 0);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(400px, 1fr) minmax(480px, auto)', gap: 14, alignItems: 'start' }}>
      <div>
        <Section title={t('catalog.composer.title')}>
          <div className="card">
            <SelectField label={t('catalog.composer.node')} value={nodeId} options={nodeOptions} onChange={(v) => { setNodeId(v); setPositions({}); }} hint={t('catalog.composer.nodeHint')} />
            {node && (
              <p className="hint" style={{ margin: '2px 0 8px' }}>
                {node.description ?? node.name} — CPU {node.cpu.count} × {node.cpu.model}{node.gpu ? ` · GPU ${node.gpu.count} × ${node.gpu.model} (${node.gpu.memoryGB} GB, ${node.gpu.wattsW} W)` : ''} · NIC {node.nics.map((x) => `${x.role} ${x.count}×${x.portsPerNic}×${x.portGbps}G`).join(', ')} · <SourceBadge source={node.source} />
              </p>
            )}
            <SelectField label={t('catalog.composer.rack')} value={rackId} options={RACK_MODELS.map((r) => ({ value: r.id, label: `${r.name} — ${r.rackUnits}${r.form === 'eia-19' ? 'U' : 'OU'}` }))} onChange={setRackId} />
            <NumberField label={t('catalog.composer.nodes')} value={n} step={1} min={1} onChange={setN} hint={fit ? t('catalog.composer.fitHint', { max: fit.max, byRU: fit.byRU, cooling: node?.cooling.kind ?? '', cap: fit.kwCap, byKW: fit.byKW }) : undefined} />
            {fit && <p className="hint" style={{ margin: '0 0 6px' }}>{t('catalog.composer.kwCapNote')}</p>}

            <div className="secondary" style={{ fontSize: 12, fontWeight: 600, marginTop: 8 }}>{t('catalog.composer.switches')}</div>
            {switchRows.map((r, i) => (
              <div key={i} className="row" style={{ gap: 6, marginTop: 4 }}>
                <div className="grow"><Select value={r.id} options={switchItems.map((s) => ({ value: s.id, label: `${s.name} (${s.switch?.rackUnits ?? 1}U · ${s.power?.nameplateKW ?? 0} kW)` }))} onChange={(v) => setSwitchRows(switchRows.map((x, j) => (j === i ? { ...x, id: v } : x)))} /></div>
                <input type="number" min={1} step={1} value={r.count} style={{ width: 60 }} aria-label={t('catalog.composer.count')} onChange={(e) => setSwitchRows(switchRows.map((x, j) => (j === i ? { ...x, count: Math.max(1, Number(e.target.value) || 1) } : x)))} />
                <button className="btn ghost sm" onClick={() => setSwitchRows(switchRows.filter((_, j) => j !== i))} title={t('catalog.composer.remove')}><Icon name="trash" size={13} /></button>
              </div>
            ))}
            <button className="btn sm" style={{ marginTop: 4 }} disabled={!switchItems.length} onClick={() => setSwitchRows([...switchRows, { id: switchItems.find((s) => /sn2201|oob/i.test(s.id))?.id ?? switchItems[0].id, count: 1 }])}><Icon name="plus" size={13} />{t('catalog.composer.addSwitch')}</button>

            <div className="fields-2" style={{ marginTop: 8 }}>
              <div>
                <NumberField label={t('catalog.composer.shelves')} value={shelves.count} step={1} min={0} onChange={(v) => setShelves({ ...shelves, count: Math.max(0, Math.round(v)) })} />
                <NumberField label={t('catalog.composer.shelfKW')} unit="kW" value={shelves.ratingKW} step={1} min={0} onChange={(v) => setShelves({ ...shelves, ratingKW: v })} hint={t('catalog.composer.shelfHint')} />
              </div>
              <div>
                <NumberField label={t('catalog.composer.shelfUnits')} unit={unit} value={shelves.units} step={1} min={1} onChange={(v) => setShelves({ ...shelves, units: Math.max(1, Math.round(v)) })} />
                <NumberField label={t('catalog.composer.blanks')} value={blanks} step={1} min={0} onChange={(v) => setBlanks(Math.max(0, Math.round(v)))} hint={t('catalog.composer.blanksHint')} />
              </div>
            </div>
            <TextField label={t('catalog.composer.id')} value={id} onChange={setId} hint={t('catalog.composer.idHint', { id: `${nodeId}-${n}x` })} />
            <TextField label={t('catalog.composer.name')} value={name} onChange={setName} />
            {result.error && <div className="status error" style={{ display: 'flex', marginTop: 6 }}><Icon name="error" size={13} /> {result.error}</div>}
            {errors.map((e, i) => <div key={i} className="status error" style={{ display: 'flex' }}><Icon name="error" size={13} /> {e}</div>)}
            <div className="row" style={{ marginTop: 10 }}>
              <span className="grow" />
              <button className="btn primary" disabled={!item || errors.length > 0} onClick={() => item && onSave(item)} data-composer-save><Icon name="save" size={13} />{target === 'project' ? t('catalog.composer.saveProject') : t('catalog.composer.saveLibrary')}</button>
            </div>
          </div>
        </Section>

        <Section title={t('catalog.composer.components', { used: placement.usedU, cap: placement.ruCap, unit })} actions={<button className="btn ghost sm" onClick={() => { setPositions({}); setSelComp(null); }} disabled={!Object.keys(positions).length}>{t('catalog.composer.autoLayout')}</button>}>
          <DataTable
            columns={[
              { key: 'u', header: 'U', num: true, render: (p: (typeof placement.placed)[number]) => (p.u != null ? `${p.u}${p.units > 1 ? `–${p.u + p.units - 1}` : ''}` : '—'), sortValue: (p) => p.u ?? 999 },
              { key: 'label', header: t('catalog.composer.component'), render: (p) => <span style={{ color: p.conflict ? 'var(--critical)' : undefined }}>{p.label}{p.conflict ? ` · ${t(`catalog.bp.conflict.${p.conflict}`)}` : ''}</span> },
              { key: 'kind', header: t('catalog.col.category'), render: (p) => t(`catalog.bp.kind.${p.kind}`) },
              { key: 'units', header: unit, num: true, render: (p) => p.units },
              { key: 'kw', header: 'kW', num: true, render: (p) => (p.kw ? p.kw.toFixed(1) : '—') },
              { key: 'mv', header: '', render: (p) => (
                <span className="row" style={{ gap: 2 }}>
                  <button className="btn ghost sm" disabled={p.u == null} onClick={(e) => { e.stopPropagation(); move(p.id, 1); }} title={t('catalog.bp.moveUp')} data-comp-up={p.id}>▲</button>
                  <button className="btn ghost sm" disabled={p.u == null} onClick={(e) => { e.stopPropagation(); move(p.id, -1); }} title={t('catalog.bp.moveDown')} data-comp-down={p.id}>▼</button>
                </span>
              ) },
            ]}
            rows={placement.placed}
            rowKey={(p) => p.id}
            selectedKeys={selComp ? [selComp] : []}
            onRowClick={(p) => setSelComp(p.id)}
            initialSort={{ key: 'u', dir: -1 }}
            maxHeight={360}
          />
          <p className="hint">{t('catalog.composer.componentsHint', { kw: itKW.toFixed(1) })}</p>
        </Section>
      </div>

      <div>
        <Section title={t('catalog.composer.blueprint')}>
          <div style={{ overflowX: 'auto' }}>
            <RackBlueprint rackModelId={rackId} entries={entries} overflowU={overflowU} issues={placement.issues.map((i) => i.message)} selectedId={selComp} onSelect={setSelComp} onMove={move} />
          </div>
        </Section>
        {item && (
          <Section title={t('catalog.composer.preview')}>
            <div className="card">
              <div className="row wrap" style={{ gap: 6 }}><h3 style={{ margin: 0 }}>{item.name}</h3><span className="grow" /><SourceBadge source={item.source} /><span className="badge">{catLabel(t, item.category)}</span></div>
              <div className="muted mono" style={{ fontSize: 11.5 }}>{item.id}</div>
              <div className="grid-3" style={{ marginTop: 8 }}>
                <Stat label={t('catalog.stat.power')} value={`${item.power!.nameplateKW.toFixed(1)} kW`} delta={t('catalog.stat.powerDelta', { typical: item.power!.typicalKW.toFixed(1), peak: item.power!.peakKW.toFixed(1) })} />
                <Stat label={t('catalog.stat.cooling')} value={item.cooling!.liquidFraction > 0 ? t('catalog.stat.liquid', { pct: Math.round(item.cooling!.liquidFraction * 100) }) : t('catalog.stat.air')} delta={`${item.cooling!.airflowM3s.toFixed(2)} m³/s · ${item.cooling!.liquidFlowLpm} LPM`} />
                <Stat label={t('catalog.stat.weightDims')} value={`${fmtInt(item.weightKg)} kg`} delta={`${item.dims.w} × ${item.dims.d} × ${item.dims.h} m · ${item.rackUnits}U`} />
                {item.compute && item.compute.gpus > 0 && <Stat label="GPU" value={fmtInt(item.compute.gpus)} delta={`${t('catalog.stat.nodesXgpus', { nodes: item.compute.nodesPerRack ?? '?', gpus: item.compute.gpusPerNode ?? '?' })} · ${t('catalog.stat.rails', { n: item.compute.railsPerNode ?? '—' })}`} />}
                {item.compute && <Stat label={t('catalog.stat.ports')} value={`SO ${item.compute.scaleOutPortsPerGpu * item.compute.gpus} × ${item.compute.scaleOutPortGbps}G`} delta={`FE ${item.compute.frontendPorts} · ST ${item.compute.storagePorts} · OOB ${item.compute.oobPorts}`} />}
                {item.storage && <Stat label={t('catalog.stat.storage')} value={`${fmtInt(item.storage.rawTB)} TB`} delta={t('catalog.stat.storageDelta', { usable: fmtInt(item.storage.usableTB), gbps: item.storage.throughputGBps })} />}
                <Stat label="CAPEX" value={`$${fmtInt(item.cost.capexUSD)}`} delta={t('catalog.stat.capexDelta', { h: item.cost.installHours, wk: item.cost.leadTimeWeeks })} />
              </div>
              <p className="hint" style={{ marginTop: 8 }}>{item.notes}</p>
            </div>
          </Section>
        )}
      </div>
    </div>
  );
}
