// r4 stream C (spec §3.2 Layers): floating layers panel shared by Plan · Section · Elevation. Registry = core scene/layers.ts;
// presets Arch / Power / Cooling / Network / All; status badges for derived / pending layers.
import { LAYERS, LAYER_GROUPS, LAYER_PRESETS, type LayerPresetId } from '@aidc/core';
import { useApp } from '../store/appStore.ts';
import { useT } from '../i18n/index.ts';

const PRESETS: LayerPresetId[] = ['arch', 'power', 'cooling', 'network', 'all'];

export function LayersPanel() {
  const t = useT();
  const v = useApp((s) => s.view2d);
  if (!v.layersOpen) return null;
  const on = new Set<string>(v.layers);
  const samePreset = (p: LayerPresetId) => LAYER_PRESETS[p].length === v.layers.length && LAYER_PRESETS[p].every((l) => on.has(l));
  return (
    <div className="v2d-layers glass" data-v2d-layers role="region" aria-label={t('view2d.layers')}>
      <div className="v2d-layers-head">
        <strong>{t('view2d.layers')}</strong>
        <span className="hint">{t('view2d.layersCount', { on: v.layers.length, total: LAYERS.length })}</span>
        <span style={{ flex: 1 }} />
        <button className="btn ghost sm" onClick={() => v.set({ layersOpen: false })} title={t('view2d.close')} aria-label={t('view2d.close')}>✕</button>
      </div>
      <div className="v2d-layers-presets">
        {PRESETS.map((p) => (
          <button key={p} className={`btn sm ${samePreset(p) ? 'active' : ''}`} data-preset={p} onClick={() => v.applyPreset(p)}>{t(`view2d.preset.${p}`)}</button>
        ))}
      </div>
      <div className="v2d-layers-body">
        {LAYER_GROUPS.map((g) => {
          const defs = LAYERS.filter((l) => l.group === g);
          const n = defs.filter((d) => on.has(d.id)).length;
          return (
            <fieldset key={g} className="v2d-layer-group">
              <legend>
                <label>
                  <input
                    type="checkbox"
                    checked={n === defs.length}
                    ref={(el) => { if (el) el.indeterminate = n > 0 && n < defs.length; }}
                    onChange={(e) => {
                      const next = new Set(on);
                      for (const d of defs) {
                        if (e.target.checked) next.add(d.id);
                        else next.delete(d.id);
                      }
                      v.set({ layers: LAYERS.map((l) => l.id).filter((l) => next.has(l)) });
                    }}
                  />
                  {t(`view2d.group.${g}`)}
                </label>
              </legend>
              {defs.map((d) => (
                <label key={d.id} className="v2d-layer" data-layer={d.id}>
                  <input type="checkbox" checked={on.has(d.id)} onChange={(e) => v.setLayer(d.id, e.target.checked)} />
                  <span className="v2d-layer-name">{t(d.i18nKey)}</span>
                  {d.status !== 'exists' && <span className={`v2d-badge ${d.status}`} title={t(`view2d.status.${d.status}.title`)}>{t(`view2d.status.${d.status}`)}</span>}
                </label>
              ))}
            </fieldset>
          );
        })}
      </div>
    </div>
  );
}
