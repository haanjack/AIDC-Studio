import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { findCatalogItem, footprintRect, type EquipmentInstance, type Hall } from '@aidc/core';
import { planToThree } from './coords.ts';

interface PodLabel {
  key: string;
  name: string;
  x: number;
  y: number;
  z: number;
  racks: number;
  kw: number;
  gpus: number;
  cooling: number;
  units: number;
}

/** Wall letter of a CRAH tag → label (polish v2 2차: rows-along-Y halls have N / S row-end walls; every non-W letter used to read "East"). */
const WALL_NAME: Record<string, string> = { N: 'North', S: 'South', E: 'East', W: 'West' };

/** Sparse pod / CRAH-group labels. Size follows camera distance (clamped); hidden when very close. */
export function Labels({ hall, items }: { hall: Hall; items: EquipmentInstance[] }) {
  const labels = useMemo(() => {
    const pods = new Map<string, { minX: number; minY: number; maxX: number; maxY: number; racks: number; kw: number; gpus: number; name: string; h: number; cooling: number; units: number }>();
    for (const e of items) {
      const key = e.podId ?? (e.tag.startsWith('CRAH-') ? `crah-${e.tag[5]}` : null);
      if (!key) continue;
      const item = findCatalogItem(e.catalogId);
      if (!item) continue;
      const r = footprintRect(item.dims, e.position, e.rotationDeg);
      let p = pods.get(key);
      if (!p) {
        const name = key.startsWith('pod-services') ? 'Services / Spine' : key.startsWith('crah-') ? `CRAH ${WALL_NAME[key.slice(-1)] ?? key.slice(-1)}` : e.tag.split('-')[0];
        pods.set(key, (p = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, racks: 0, kw: 0, gpus: 0, name, h: 0, cooling: 0, units: 0 }));
      }
      p.minX = Math.min(p.minX, r.x);
      p.minY = Math.min(p.minY, r.y);
      p.maxX = Math.max(p.maxX, r.x + r.w);
      p.maxY = Math.max(p.maxY, r.y + r.d);
      p.h = Math.max(p.h, item.dims.h);
      if (item.category.endsWith('rack')) p.racks++;
      p.kw += (item.power?.nameplateKW ?? 0) * (e.loadFactor ?? 1);
      p.gpus += item.compute?.gpus ?? 0;
      if (key.startsWith('crah-')) {
        p.cooling += item.capacity?.coolingKW ?? 0;
        p.units++;
      }
    }
    const out: PodLabel[] = [];
    for (const [key, p] of pods) {
      out.push({ key, name: p.name, x: (p.minX + p.maxX) / 2, y: (p.minY + p.maxY) / 2, z: p.h + (key.startsWith('crah') ? 0.6 : 1.2), racks: p.racks, kw: p.kw, gpus: p.gpus, cooling: p.cooling, units: p.units });
    }
    return out;
  }, [items]);

  const refs = useRef<(HTMLDivElement | null)[]>([]);
  const tmp = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera }) => {
    labels.forEach((l, i) => {
      const el = refs.current[i];
      if (!el) return;
      planToThree(l.x, l.y, l.z, tmp);
      const d = camera.position.distanceTo(tmp);
      const s = Math.min(1, Math.max(0.55, 30 / d));
      el.style.transform = `scale(${s.toFixed(3)})`;
      el.style.opacity = d < 6 ? '0' : '1';
    });
  });

  return (
    <group>
      {labels.map((l, i) => (
        <Html key={l.key} position={planToThree(l.x, l.y, l.z)} center zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
          <div
            ref={(el) => {
              refs.current[i] = el;
            }}
            style={{
              background: 'rgba(10,14,18,0.78)',
              borderLeft: `3px solid ${l.key.startsWith('crah') ? '#5fc3e8' : '#4fb477'}`,
              color: '#e6edf3',
              padding: '4px 8px',
              borderRadius: 4,
              font: '600 13px/1.25 system-ui, sans-serif',
              whiteSpace: 'nowrap',
              letterSpacing: 0.2,
              transition: 'opacity 150ms',
            }}
          >
            {l.name}
            <div style={{ fontWeight: 400, fontSize: 11, opacity: 0.8 }}>
              {l.cooling > 0
                ? `${l.units} units · ${l.cooling >= 1000 ? `${(l.cooling / 1000).toFixed(2)} MW` : `${Math.round(l.cooling)} kW`} cooling`
                : `${l.racks > 0 ? `${l.racks} racks · ` : ''}${l.gpus > 0 ? `${l.gpus.toLocaleString()} GPU · ` : ''}${l.kw >= 1000 ? `${(l.kw / 1000).toFixed(2)} MW` : `${Math.round(l.kw)} kW`}`}
            </div>
          </div>
        </Html>
      ))}
      <Html position={planToThree(0.2, -0.6, 0.05)} zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
        <div style={{ color: '#9be15d', font: '600 14px system-ui, sans-serif', whiteSpace: 'nowrap', textShadow: '0 1px 3px #000' }}>
          {hall.name} · {hall.width.toFixed(1)} × {hall.depth.toFixed(1)} m
        </div>
      </Html>
    </group>
  );
}
