// r4 stream C: the mounted 2D pane registers its imperative actions here, so a toolbar rendered elsewhere (ViewportToolbar in
// 2D-only mode) can export or fit without prop drilling. Not state: nothing re-renders on it.
export interface Pane2DApi {
  exportSvg(): Promise<void>;
  exportPng(): Promise<void>;
  fitHall(): void;
  zoom(factor: number): void;
}

let active: Pane2DApi | null = null;

export const pane2D = {
  get(): Pane2DApi | null {
    return active;
  },
  set(api: Pane2DApi | null) {
    active = api;
  },
};

/** A 2D pan / zoom gesture is in progress (Split: the 3D canvas pauses its render loop meanwhile, FrameGate3D). Not state. */
let gestureActive = false;
const gestureListeners = new Set<(active: boolean) => void>();

export const gesture2D = {
  get active(): boolean {
    return gestureActive;
  },
  set(active: boolean) {
    if (active === gestureActive) return;
    gestureActive = active;
    for (const l of gestureListeners) l(active);
  },
  subscribe(l: (active: boolean) => void): () => void {
    gestureListeners.add(l);
    return () => {
      gestureListeners.delete(l);
    };
  },
};

/** Download a blob with a file name (the same anchor pattern as the 3D screenshot button). */
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
