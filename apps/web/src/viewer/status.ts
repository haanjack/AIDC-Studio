/** Lightweight runtime probe (also exposed on window for scripted screenshots). */
export const viewerStatus = {
  frames: 0,
  fps: 0,
  glbPending: 0,
  glbLoaded: 0,
  drawCalls: 0,
  triangles: 0,
  renderer: '',
  glError: 0,
  postfx: true,
  ao: true,
  fxLevel: 0,
  layerRenders: 0,
  frameBuilds: 0,
  hoverChanges: 0,
};

declare global {
  interface Window {
    __viewerStatus?: typeof viewerStatus;
    /** debug switches: { postfx?: boolean; ao?: boolean } */
    __AIDC_VIEWER_FLAGS?: { postfx?: boolean; ao?: boolean; nanGuard?: boolean; aoHalfRes?: boolean; autoFallback?: boolean; tooltip?: boolean; controls?: boolean };
  }
}

if (typeof window !== 'undefined') window.__viewerStatus = viewerStatus;
