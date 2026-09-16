// QA r4 view2d (spec §3.4 in Split): while the user pans / zooms the 2D pane, the 3D canvas next to it stops its render loop and keeps
// its last frame (preserveDrawingBuffer); it resumes when the gesture settles. On the 162 MW hall the continuously rendering 3D viewer
// alone runs at ~50 ms per frame on the QA iGPU, which held a Split 2D pan at 50 ms although the 2D redraw costs < 1 ms. Nothing in the
// 3D view changes during a 2D gesture (the camera footprint is read-only), so no content is lost.
// Viewer3D passes `frameloop={useGesture2D() ? 'never' : 'always'}` to its <Canvas>: R3F re-applies the Canvas prop on every render,
// so calling setFrameloop from inside the canvas does not stick. R3F restarts the clock on the switch (no large delta on resume).
import { useEffect, useSyncExternalStore } from 'react';
import { useThree } from '@react-three/fiber';
import { gesture2D } from './runtime.ts';

const getActive = () => gesture2D.active;
const getServer = () => false;

/** true while a 2D pan / zoom gesture is in progress */
export function useGesture2D(): boolean {
  return useSyncExternalStore(gesture2D.subscribe, getActive, getServer);
}

/** dev / QA hook inside the 3D canvas (like window.__aidcView2d): the loop state actually in effect */
export function FrameGate3D() {
  const getState = useThree((s) => s.get);
  useEffect(() => {
    const w = window as unknown as { __aidcFrameGate?: unknown };
    const hook = { frameloop: () => getState().frameloop, gesture: () => gesture2D.active };
    w.__aidcFrameGate = hook;
    return () => {
      if (w.__aidcFrameGate === hook) w.__aidcFrameGate = undefined;
    };
  }, [getState]);
  return null;
}
