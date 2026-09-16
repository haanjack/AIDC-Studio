import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { BlendFunction, BloomEffect, Effect, EffectComposer, EffectPass, RenderPass, SMAAEffect, SMAAPreset, ToneMappingEffect, ToneMappingMode } from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import { viewerStatus } from './status.ts';

/**
 * Replaces NaN / Inf / negative colours with black. Some GL backends (e.g. ANGLE-OpenGL on Mesa radeonsi)
 * produce NaN AO samples; without this guard the bloom mip-chain spreads them over the whole frame.
 */
class NanGuardEffect extends Effect {
  constructor() {
    super(
      'NanGuardEffect',
      /* glsl */ `
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        vec4 c = inputColor;
        bool bad = any(isnan(c)) || any(isinf(c)) || any(notEqual(c, c)) || dot(abs(c.rgb), vec3(1.0)) > 6.0e4;
        outputColor = bad ? vec4(0.0, 0.0, 0.0, 1.0) : max(c, vec4(0.0));
      }`,
      { blendFunction: BlendFunction.SRC },
    );
  }
}

export interface PostFXProps {
  ao?: boolean;
  nanGuard?: boolean;
  aoHalfRes?: boolean;
  /** called when the composited frame reads back fully black (driver incompatibility) */
  onBlackFrame?: () => void;
}

/**
 * Post-processing chain: scene → N8AO → NaN guard → bloom → ACES filmic → SMAA.
 * If the composited frame reads back black (seen with N8AO on ANGLE-OpenGL / Mesa radeonsi) the viewer
 * steps down: without AO, then plain rendering.
 * Rendered at useFrame priority 1 (replaces R3F's default render).
 */
export function PostFX({ ao = true, nanGuard = true, aoHalfRes = true, onBlackFrame }: PostFXProps) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const dpr = useThree((s) => s.viewport.dpr);

  const composer = useMemo(() => {
    const c = new EffectComposer(gl, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
    c.addPass(new RenderPass(scene, camera));
    if (ao) {
      const n8 = new N8AOPostPass(scene, camera, size.width, size.height);
      Object.assign(n8.configuration, {
        aoRadius: 1.1,
        distanceFalloff: 0.5,
        intensity: 2.4,
        aoSamples: 12,
        denoiseSamples: 6,
        denoiseRadius: 10,
        halfRes: aoHalfRes,
        depthAwareUpsampling: aoHalfRes,
        gammaCorrection: false,
        screenSpaceRadius: false,
      });
      c.addPass(n8);
    }
    if (nanGuard) c.addPass(new EffectPass(camera, new NanGuardEffect()));
    const bloom = new BloomEffect({ intensity: 0.65, luminanceThreshold: 0.95, luminanceSmoothing: 0.3, mipmapBlur: true, radius: 0.55 });
    const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    c.addPass(new EffectPass(camera, bloom, tone));
    c.addPass(new EffectPass(camera, new SMAAEffect({ preset: SMAAPreset.HIGH })));
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, scene, camera, ao, nanGuard, aoHalfRes]);

  useEffect(() => {
    composer.setSize(size.width, size.height);
  }, [composer, size.width, size.height, dpr]);

  useEffect(() => () => composer.dispose(), [composer]);

  // black-frame self check: async readback (PBO + fence sync) of one row, twice per composer lifetime
  const frame = useRef(0);
  const reported = useRef(false);
  const probe = useRef<{ buf: WebGLBuffer; sync: WebGLSync; w: number } | null>(null);
  useEffect(() => {
    frame.current = 0;
    reported.current = false;
    viewerStatus.ao = ao;
    viewerStatus.postfx = true;
    return () => {
      const p = probe.current;
      if (p) {
        const ctx = gl.getContext() as WebGL2RenderingContext;
        ctx.deleteSync(p.sync);
        ctx.deleteBuffer(p.buf);
        probe.current = null;
      }
    };
  }, [composer, ao, gl]);

  useFrame((_, delta) => {
    composer.render(delta);
    const f = ++frame.current;
    if (!onBlackFrame || reported.current) return;
    const ctx = gl.getContext() as WebGL2RenderingContext;
    const pending = probe.current;
    if (pending) {
      if (ctx.clientWaitSync(pending.sync, 0, 0) === ctx.TIMEOUT_EXPIRED) return;
      ctx.deleteSync(pending.sync);
      const row = new Uint8Array(pending.w * 4);
      ctx.bindBuffer(ctx.PIXEL_PACK_BUFFER, pending.buf);
      ctx.getBufferSubData(ctx.PIXEL_PACK_BUFFER, 0, row);
      ctx.bindBuffer(ctx.PIXEL_PACK_BUFFER, null);
      ctx.deleteBuffer(pending.buf);
      probe.current = null;
      let sum = 0;
      const stride = Math.max(1, Math.floor(pending.w / 64));
      for (let x = 0; x < pending.w; x += stride) sum += row[x * 4] + row[x * 4 + 1] + row[x * 4 + 2];
      if (sum === 0) {
        reported.current = true;
        console.info(`[viewer] composited frame read back black (${ao ? 'AO on' : 'AO off'}) — falling back to a simpler post-processing chain`);
        onBlackFrame();
      }
      return;
    }
    if (f !== 30 && f !== 150) return;
    gl.setRenderTarget(null);
    const w = ctx.drawingBufferWidth;
    const h = ctx.drawingBufferHeight;
    const buf = ctx.createBuffer();
    if (!buf) return;
    ctx.bindBuffer(ctx.PIXEL_PACK_BUFFER, buf);
    ctx.bufferData(ctx.PIXEL_PACK_BUFFER, w * 4, ctx.STREAM_READ);
    ctx.readPixels(0, Math.floor(h / 2), w, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, 0);
    ctx.bindBuffer(ctx.PIXEL_PACK_BUFFER, null);
    const sync = ctx.fenceSync(ctx.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!sync) {
      ctx.deleteBuffer(buf);
      return;
    }
    probe.current = { buf, sync, w };
  }, 1);

  return null;
}

/** Fallback renderer without post-processing (renderer-side ACES tone mapping). */
export function PlainRender() {
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    viewerStatus.postfx = false;
    viewerStatus.ao = false;
    return () => {
      gl.toneMapping = THREE.NoToneMapping;
    };
  }, [gl]);
  useFrame(({ gl: r, scene, camera }) => {
    r.setRenderTarget(null);
    r.render(scene, camera);
  }, 1);
  return null;
}
