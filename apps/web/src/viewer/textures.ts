import * as THREE from 'three';

/** Procedural canvas textures so the viewer looks finished without any external assets. */

const cache = new Map<string, THREE.Texture>();

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  return [c, ctx];
}

function toTexture(c: HTMLCanvasElement, srgb = true, repeat = false): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  if (repeat) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
  }
  t.needsUpdate = true;
  return t;
}

function cached<T extends THREE.Texture>(key: string, make: () => T): T {
  let t = cache.get(key) as T | undefined;
  if (!t) {
    t = make();
    cache.set(key, t);
  }
  return t;
}

// deterministic pseudo random
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** One 0.6 m epoxy floor tile with speckle and seams. Repeat across the hall. */
export function floorTexture(): THREE.CanvasTexture {
  return cached('floor', () => {
    const [c, g] = makeCanvas(512, 512);
    g.fillStyle = '#5d636b';
    g.fillRect(0, 0, 512, 512);
    const r = rng(7);
    for (let i = 0; i < 9000; i++) {
      const v = 80 + Math.floor(r() * 40);
      g.fillStyle = `rgba(${v},${v + 3},${v + 8},${0.12 + r() * 0.2})`;
      g.fillRect(r() * 512, r() * 512, 1 + r() * 2, 1 + r() * 2);
    }
    const grad = g.createRadialGradient(256, 256, 40, 256, 256, 380);
    grad.addColorStop(0, 'rgba(255,255,255,0.05)');
    grad.addColorStop(1, 'rgba(0,0,0,0.06)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 512, 512);
    g.strokeStyle = 'rgba(28,30,34,0.85)';
    g.lineWidth = 3;
    g.strokeRect(1.5, 1.5, 509, 509);
    g.strokeStyle = 'rgba(160,168,176,0.25)';
    g.lineWidth = 1;
    g.strokeRect(4, 4, 504, 504);
    return toTexture(c, true, true);
  });
}

export function ceilingTexture(): THREE.CanvasTexture {
  return cached('ceiling', () => {
    const [c, g] = makeCanvas(256, 256);
    g.fillStyle = '#c9ccd0';
    g.fillRect(0, 0, 256, 256);
    const r = rng(3);
    for (let i = 0; i < 2500; i++) {
      g.fillStyle = `rgba(90,90,95,${r() * 0.12})`;
      g.fillRect(r() * 256, r() * 256, 1, 1);
    }
    g.strokeStyle = '#eef0f2';
    g.lineWidth = 8;
    g.strokeRect(0, 0, 256, 256);
    return toTexture(c, true, true);
  });
}

export function wallTexture(): THREE.CanvasTexture {
  return cached('wall', () => {
    const [c, g] = makeCanvas(512, 512);
    g.fillStyle = '#8d9399';
    g.fillRect(0, 0, 512, 512);
    const r = rng(11);
    for (let i = 0; i < 6000; i++) {
      const v = 120 + Math.floor(r() * 50);
      g.fillStyle = `rgba(${v},${v},${v + 4},${0.08 + r() * 0.12})`;
      g.fillRect(r() * 512, r() * 512, 2, 2);
    }
    g.fillStyle = 'rgba(40,44,50,0.35)';
    for (let x = 0; x < 512; x += 128) g.fillRect(x, 0, 2, 512);
    return toTexture(c, true, true);
  });
}

export type RackFaceKind = 'gpu-liquid' | 'gpu-air' | 'cpu' | 'storage' | 'network' | 'mgmt';

interface FaceTextures {
  map: THREE.CanvasTexture;
  emissive: THREE.CanvasTexture;
}

function honeycomb(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string, step = 5) {
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  g.fillStyle = color;
  for (let yy = y, row = 0; yy < y + h + step; yy += step * 0.866, row++) {
    for (let xx = x + (row % 2 ? step / 2 : 0); xx < x + w + step; xx += step) {
      g.beginPath();
      g.arc(xx, yy, step * 0.32, 0, Math.PI * 2);
      g.fill();
    }
  }
  g.restore();
}

function led(g: CanvasRenderingContext2D, e: CanvasRenderingContext2D, x: number, y: number, color: string, r = 1.6) {
  g.fillStyle = color;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
  e.fillStyle = color;
  e.beginPath();
  e.arc(x, y, r * 1.2, 0, Math.PI * 2);
  e.fill();
}

/**
 * Rack front door (256 × 1024 ≈ 0.6 m × 2.3 m). Drawn top → bottom in rack units.
 */
export function rackFrontTexture(kind: RackFaceKind): FaceTextures {
  const key = `front-${kind}`;
  const map = cached(key, () => {
    const W = 256;
    const H = 1024;
    const [c, g] = makeCanvas(W, H);
    const [ec, e] = makeCanvas(W, H);
    e.fillStyle = '#000';
    e.fillRect(0, 0, W, H);
    g.fillStyle = '#101214';
    g.fillRect(0, 0, W, H);
    const r = rng(kind.length * 97);
    const U = H / 48; // 48U rack
    const left = 14;
    const right = W - 14;
    const iw = right - left;

    const unit = (u: number, n = 1) => ({ y: 8 + u * U, h: n * U - 1.5 });

    const powerShelf = (u: number) => {
      const { y, h } = unit(u);
      g.fillStyle = '#2a2d31';
      g.fillRect(left, y, iw, h);
      for (let i = 0; i < 6; i++) {
        const x = left + 4 + i * (iw / 6);
        g.fillStyle = '#3b3f45';
        g.fillRect(x, y + 3, iw / 6 - 8, h - 6);
        honeycomb(g, x + 2, y + 5, iw / 6 - 18, h - 10, '#070809', 4);
        led(g, e, x + iw / 6 - 12, y + h / 2, '#a8d5b0', 1.3);
      }
    };
    const computeTray = (u: number, light = true) => {
      const { y, h } = unit(u);
      g.fillStyle = light ? '#4a4d52' : '#2b2f33';
      g.fillRect(left, y, iw, h);
      g.fillStyle = '#0c0d0f';
      g.fillRect(left + 3, y + 2.5, iw - 6, h - 5);
      honeycomb(g, left + 34, y + 3, iw - 80, h - 6, '#23262a', 4.2);
      // E1.S drive slots
      for (let i = 0; i < 4; i++) {
        g.fillStyle = '#3a3e44';
        g.fillRect(left + 6 + i * 6.5, y + 4, 4.5, h - 8);
      }
      led(g, e, right - 30, y + h / 2, '#a8d5b0', 1.4);
      led(g, e, right - 22, y + h / 2, r() > 0.3 ? '#a8d5b0' : '#cfd8dc', 1.4);
      led(g, e, right - 14, y + h / 2, '#ffffff', 1.1);
    };
    const switchTray = (u: number, ports: number, portColor = '#1a1c1f') => {
      const { y, h } = unit(u);
      g.fillStyle = '#1d2024';
      g.fillRect(left, y, iw, h);
      const pw = (iw - 30) / ports;
      for (let i = 0; i < ports; i++) {
        g.fillStyle = portColor;
        g.fillRect(left + 24 + i * pw, y + 3, pw - 1.2, h - 6);
        g.fillStyle = '#6b7178';
        g.fillRect(left + 24 + i * pw, y + 3, pw - 1.2, 1.2);
      }
      led(g, e, left + 8, y + h / 2, '#a8d5b0', 1.3);
      led(g, e, left + 15, y + h / 2, '#c9ccd0', 1.1);
    };
    const serverU = (u: number, n: number, drives: number, ledColor: string, bezel = '#2c3035') => {
      const { y, h } = unit(u, n);
      g.fillStyle = bezel;
      g.fillRect(left, y, iw, h);
      g.fillStyle = '#16181b';
      g.fillRect(left + 3, y + 3, iw - 6, h - 6);
      const dw = (iw - 50) / drives;
      for (let i = 0; i < drives; i++) {
        g.fillStyle = '#3d4248';
        g.fillRect(left + 8 + i * dw, y + 5, dw - 2, h - 10);
        g.fillStyle = '#23272b';
        g.fillRect(left + 8 + i * dw, y + h - 10, dw - 2, 3);
        if (r() > 0.25) led(g, e, left + 8 + i * dw + dw / 2 - 1, y + 8, ledColor, 1.0);
      }
      honeycomb(g, right - 38, y + 5, 30, h - 10, '#0b0c0e', 4);
      led(g, e, right - 6, y + h / 2, '#a8d5b0', 1.2);
    };
    const blank = (u: number, n = 1) => {
      const { y, h } = unit(u, n);
      g.fillStyle = '#17191c';
      g.fillRect(left, y, iw, h);
      g.fillStyle = '#23262a';
      g.fillRect(left, y + h - 2, iw, 1);
    };

    // rails
    g.fillStyle = '#1f2226';
    g.fillRect(0, 0, 12, H);
    g.fillRect(W - 12, 0, 12, H);
    for (let u = 0; u < 48; u++) {
      g.fillStyle = '#34383d';
      g.fillRect(4, 8 + u * U + U / 2, 4, 2);
      g.fillRect(W - 8, 8 + u * U + U / 2, 4, 2);
    }

    if (kind === 'gpu-liquid') {
      blank(0, 2);
      for (let u = 2; u < 5; u++) powerShelf(u);
      switchTray(5, 24);
      for (let u = 6; u < 16; u++) computeTray(u, true);
      for (let u = 16; u < 25; u++) switchTray(u, 18, '#0f1012');
      for (let u = 25; u < 33; u++) computeTray(u, true);
      for (let u = 33; u < 36; u++) powerShelf(u);
      blank(36, 12);
      // lower: liquid manifold quick-disconnect cover + neutral status band (no vendor badge)
      const y = 8 + 38 * U;
      g.fillStyle = '#0c0d0f';
      g.fillRect(left, y, iw, 8 * U);
      honeycomb(g, left + 4, y + 4, iw - 8, 8 * U - 8, '#1e2124', 5);
      g.fillStyle = '#8fa3b8';
      g.fillRect(left + iw / 2 - 30, y + 3 * U, 60, 3);
    } else if (kind === 'gpu-air') {
      blank(0, 2);
      for (let s = 0; s < 4; s++) {
        const u = 3 + s * 11;
        const { y, h } = unit(u, 10);
        g.fillStyle = '#4a4d52';
        g.fillRect(left, y, iw, h);
        g.fillStyle = '#0d0e10';
        g.fillRect(left + 4, y + 4, iw - 8, h - 8);
        honeycomb(g, left + 8, y + 8, iw - 16, h - 16, '#262a2e', 6);
        for (let i = 0; i < 8; i++) led(g, e, left + 20 + i * 26, y + h - 14, '#a8d5b0', 1.4);
      }
    } else if (kind === 'network') {
      blank(0, 1);
      for (let s = 0; s < 8; s++) {
        const u = 2 + s * 5;
        for (let k = 0; k < 4; k++) switchTray(u + k, 18, '#0b0c0e');
        // fibers
        const { y } = unit(u, 4);
        for (let f = 0; f < 36; f++) {
          const fx = left + 24 + (f / 36) * (iw - 30);
          g.strokeStyle = f % 3 === 0 ? 'rgba(150,156,162,0.8)' : 'rgba(95,100,106,0.85)';
          g.lineWidth = 1.2;
          g.beginPath();
          g.moveTo(fx, y + 6 + (f % 4) * U);
          g.quadraticCurveTo(fx + 6, y + 4 * U + 6, f % 2 ? left + 2 : right - 2, y + 4 * U + 2);
          g.stroke();
        }
      }
    } else if (kind === 'storage') {
      for (let s = 0; s < 8; s++) serverU(2 + s * 2.4, 2, 12, '#cfd8dc', '#2f3236');
      blank(22, 2);
      for (let s = 0; s < 8; s++) serverU(25 + s * 2.4, 2, 12, '#cfd8dc', '#2f3236');
    } else if (kind === 'cpu') {
      for (let s = 0; s < 20; s++) serverU(2 + s * 2.2, 2, 8, '#dfe5e8');
    } else {
      for (let s = 0; s < 12; s++) switchTray(2 + s, 24, '#101113');
      for (let s = 0; s < 6; s++) serverU(16 + s * 2.2, 2, 6, '#c9ccd0');
    }
    // door frame + perforation sheen
    g.strokeStyle = '#2b2f34';
    g.lineWidth = 6;
    g.strokeRect(3, 3, W - 6, H - 6);
    honeycomb(g, 0, 0, W, H, 'rgba(0,0,0,0.18)', 3);
    cache.set(`${key}-e`, toTexture(ec));
    return toTexture(c);
  });
  const emissive = cache.get(`${key}-e`) as THREE.CanvasTexture;
  return { map, emissive };
}

/** Rear: liquid manifolds (blue/red), power whips, fans for air-cooled. */
export function rackRearTexture(kind: RackFaceKind): FaceTextures {
  const key = `rear-${kind}`;
  const map = cached(key, () => {
    const W = 256;
    const H = 1024;
    const [c, g] = makeCanvas(W, H);
    const [ec, e] = makeCanvas(W, H);
    e.fillStyle = '#000';
    e.fillRect(0, 0, W, H);
    g.fillStyle = '#0e1012';
    g.fillRect(0, 0, W, H);
    if (kind === 'gpu-liquid') {
      // NVLink spine cartridges region
      g.fillStyle = '#1a1d20';
      g.fillRect(40, 250, W - 80, 380);
      for (let i = 0; i < 60; i++) {
        g.strokeStyle = 'rgba(70,74,80,0.9)';
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(44 + (i / 60) * (W - 88), 250);
        g.lineTo(44 + (i / 60) * (W - 88), 630);
        g.stroke();
      }
      // manifolds
      g.fillStyle = '#4a6078';
      g.fillRect(16, 40, 14, H - 80);
      g.fillStyle = '#7a5050';
      g.fillRect(W - 30, 40, 14, H - 80);
      for (let u = 0; u < 36; u++) {
        const y = 60 + u * 25;
        g.fillStyle = '#90a4ae';
        g.fillRect(30, y, 10, 5);
        g.fillRect(W - 40, y, 10, 5);
      }
      // power whips
      for (let i = 0; i < 4; i++) {
        g.fillStyle = '#212121';
        g.fillRect(56 + i * 44, 0, 10, 60);
        g.fillStyle = '#c9ccd0';
        g.fillRect(56 + i * 44, 56, 10, 6);
      }
      led(g, e, W / 2, 20, '#a8d5b0', 2);
    } else {
      for (let row = 0; row < 18; row++) {
        for (let col = 0; col < 3; col++) {
          const cx = 50 + col * 78;
          const cy = 40 + row * 54;
          g.fillStyle = '#1b1e21';
          g.fillRect(cx - 34, cy - 24, 68, 48);
          g.strokeStyle = '#2e3237';
          g.lineWidth = 2;
          g.beginPath();
          g.arc(cx, cy, 18, 0, Math.PI * 2);
          g.stroke();
          g.beginPath();
          g.arc(cx, cy, 5, 0, Math.PI * 2);
          g.stroke();
        }
      }
      for (let u = 0; u < 40; u++) {
        g.strokeStyle = u % 2 ? 'rgba(120,125,130,0.6)' : 'rgba(30,30,30,0.9)';
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(8, 30 + u * 24);
        g.lineTo(W - 8, 34 + u * 24);
        g.stroke();
      }
    }
    honeycomb(g, 0, 0, W, H, 'rgba(0,0,0,0.25)', 3);
    g.strokeStyle = '#2b2f34';
    g.lineWidth = 6;
    g.strokeRect(3, 3, W - 6, H - 6);
    cache.set(`${key}-e`, toTexture(ec));
    return toTexture(c);
  });
  return { map, emissive: cache.get(`${key}-e`) as THREE.CanvasTexture };
}

export function sidePanelTexture(light = false): THREE.CanvasTexture {
  return cached(`side-${light}`, () => {
    const [c, g] = makeCanvas(128, 512);
    g.fillStyle = light ? '#d4d6d8' : '#1a1c1f';
    g.fillRect(0, 0, 128, 512);
    const r = rng(light ? 5 : 9);
    for (let i = 0; i < 1500; i++) {
      g.fillStyle = light ? `rgba(120,120,125,${r() * 0.08})` : `rgba(90,95,100,${r() * 0.08})`;
      g.fillRect(r() * 128, r() * 512, 1, 3);
    }
    g.strokeStyle = light ? 'rgba(90,90,95,0.35)' : 'rgba(0,0,0,0.6)';
    g.lineWidth = 2;
    g.strokeRect(4, 4, 120, 504);
    g.beginPath();
    g.moveTo(0, 256);
    g.lineTo(128, 256);
    g.stroke();
    return toTexture(c);
  });
}

/** Light-colored mechanical cabinet fronts (CDU, CRAH, power). */
export function mechFrontTexture(kind: 'cdu' | 'crah' | 'power', aspect: number): FaceTextures {
  const key = `mech-${kind}-${aspect.toFixed(2)}`;
  const map = cached(key, () => {
    const W = kind === 'crah' ? 512 : 256;
    const H = Math.round(W / aspect);
    const [c, g] = makeCanvas(W, H);
    const [ec, e] = makeCanvas(W, H);
    e.fillStyle = '#000';
    e.fillRect(0, 0, W, H);
    g.fillStyle = '#d7d9db';
    g.fillRect(0, 0, W, H);
    const r = rng(W + H);
    for (let i = 0; i < 3000; i++) {
      g.fillStyle = `rgba(140,140,145,${r() * 0.06})`;
      g.fillRect(r() * W, r() * H, 2, 2);
    }
    g.strokeStyle = 'rgba(80,84,90,0.55)';
    g.lineWidth = 2;
    if (kind === 'cdu') {
      const doors = 2;
      for (let d = 0; d < doors; d++) g.strokeRect(6 + d * ((W - 12) / doors), 6, (W - 12) / doors - 4, H - 12);
      // louvers
      for (let y = H * 0.55; y < H - 20; y += 9) {
        g.fillStyle = 'rgba(60,64,70,0.55)';
        g.fillRect(18, y, W - 36, 3);
      }
      // generic status panel (plain dark inset + two indicator LEDs; no vendor wordmark or HMI screen imitation)
      g.fillStyle = '#2a2f36';
      g.fillRect(W * 0.34, H * 0.18, W * 0.32, H * 0.06);
      led(g, e, W * 0.42, H * 0.21, '#a8d5b0', 3);
      led(g, e, W * 0.58, H * 0.21, '#c9ccd0', 3);
      g.fillStyle = '#4a4f55';
      g.font = `bold ${Math.round(W * 0.07)}px sans-serif`;
      g.fillText('CDU', W * 0.42, H * 0.12);
    } else if (kind === 'crah') {
      // upper access doors
      for (let d = 0; d < 3; d++) g.strokeRect(8 + d * ((W - 16) / 3), 8, (W - 16) / 3 - 6, H * 0.45);
      // lower EC fan section (supply)
      g.fillStyle = '#4a4f55';
      g.fillRect(10, H * 0.5, W - 20, H * 0.46);
      for (let f = 0; f < 4; f++) {
        const cx = W * (0.14 + f * 0.24);
        const cy = H * 0.73;
        const rad = Math.min(W * 0.1, H * 0.18);
        g.fillStyle = '#23262a';
        g.beginPath();
        g.arc(cx, cy, rad, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = '#8a9096';
        g.lineWidth = 2;
        for (let k = 0; k < 6; k++) {
          g.beginPath();
          g.arc(cx, cy, rad * (0.3 + k * 0.12), 0, Math.PI * 2);
          g.stroke();
        }
      }
      for (let y = H * 0.5; y < H * 0.96; y += 6) {
        g.fillStyle = 'rgba(200,205,210,0.25)';
        g.fillRect(10, y, W - 20, 1.5);
      }
      // generic status panel + neutral category label (no vendor wordmark or HMI screen imitation)
      g.fillStyle = '#2a2f36';
      g.fillRect(W * 0.08, H * 0.13, W * 0.1, H * 0.05);
      led(g, e, W * 0.11, H * 0.155, '#a8d5b0', 2.5);
      led(g, e, W * 0.15, H * 0.155, '#c9ccd0', 2.5);
      g.fillStyle = '#4a4f55';
      g.font = `bold ${Math.round(H * 0.05)}px sans-serif`;
      g.fillText('CRAH', W * 0.22, H * 0.18);
    } else {
      for (let d = 0; d < 3; d++) g.strokeRect(8 + d * ((W - 16) / 3), 8, (W - 16) / 3 - 6, H - 16);
      for (let y = 30; y < H * 0.3; y += 8) {
        g.fillStyle = 'rgba(60,64,70,0.4)';
        g.fillRect(20, y, W - 40, 3);
      }
      led(g, e, W * 0.5, H * 0.4, '#c9ccd0', 3);
    }
    cache.set(`${key}-e`, toTexture(ec));
    return toTexture(c);
  });
  return { map, emissive: cache.get(`${key}-e`) as THREE.CanvasTexture };
}

export function grilleTexture(): THREE.CanvasTexture {
  return cached('grille', () => {
    const [c, g] = makeCanvas(256, 256);
    g.fillStyle = '#9ea4aa';
    g.fillRect(0, 0, 256, 256);
    for (let y = 0; y < 256; y += 10) {
      g.fillStyle = '#3c4146';
      g.fillRect(0, y, 256, 5);
    }
    return toTexture(c, true, true);
  });
}

/** Light strip / glow texture used for ceiling luminaires. */
export function glowTexture(): THREE.CanvasTexture {
  return cached('glow', () => {
    const [c, g] = makeCanvas(64, 64);
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return toTexture(c);
  });
}
