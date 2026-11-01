// Zooming an editing canvas in and out (components/ZoomControls.tsx). A zoom of 1 is the canvas fitted to its
// window; the steps are the usual ones, and a pinch or Ctrl/Cmd + wheel moves between them smoothly.

export const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
export const MIN_ZOOM = ZOOM_STEPS[0];
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];

const clamp = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** The next step above (dir 1) or below (dir -1) a zoom, which need not be on a step itself. */
export function stepZoom(zoom: number, dir: 1 | -1): number {
  const next = dir > 0 ? ZOOM_STEPS.find((s) => s > zoom + 0.001) : [...ZOOM_STEPS].reverse().find((s) => s < zoom - 0.001);
  return next ?? clamp(zoom);
}

/** The zoom after a wheel movement of deltaY (negative zooms in), as a pinch on a trackpad sends. */
export function wheelZoom(zoom: number, deltaY: number): number {
  return clamp(zoom * Math.exp(-deltaY / 200));
}
