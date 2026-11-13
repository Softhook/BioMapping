/**
 * GSR graph input: mouse press/drag/release/move, wheel zoom and pan, and the
 * canvas cursor. Split from sketch.mjs, which keeps setup() and drawing.
 *
 * p5 hears these events anywhere on the page (its global-mode handlers are
 * page-wide), so every handler that acts on a position checks the event was
 * aimed at the graph canvas first — see _eventOnCanvas.
 */
import { AppState } from '../core/app_state.mjs';
import { GSR_CONST } from '../core/constants.mjs';
import { Controllers } from '../core/controllers.mjs';
import { GSRRenderer } from './renderer.mjs';

// Coalesced redraw functions for high-frequency input events (drag, hover, wheel).
// GSREvents is reached via the Controllers registry (core/controllers.mjs),
// which events.mjs only populates once its own module has fully evaluated —
// reading Controllers.events at this module's top level could still see it
// undefined depending on load order. setup() runs only once every module in
// the graph has finished loading, so it calls initInputRedraws() to assign
// them then; until that point they redraw directly.
const _safeRedraw = () => {
  if (typeof redraw === 'function') redraw();
};
let coalescedDragRedraw = _safeRedraw;
let coalescedHoverRedraw = _safeRedraw;
let coalescedZoomRedraw = _safeRedraw;

export function initInputRedraws() {
  const coalesce = Controllers.events.rafCoalesce;
  coalescedDragRedraw = coalesce ? coalesce(_safeRedraw) : _safeRedraw;
  coalescedHoverRedraw = coalesce ? coalesce(_safeRedraw) : _safeRedraw;
  coalescedZoomRedraw = coalesce ? coalesce(_safeRedraw) : _safeRedraw;
}

/** The canvas's own listeners: hover tracking, context menu, and a page-wide
 * mouseup so a drag never gets stuck if released outside the canvas. */
export function installCanvasInputListeners(canvasEl) {
  canvasEl.oncontextmenu = (e) => {
    e.preventDefault();
  };

  // Track whether mouse is actually over the canvas (stale coordinates otherwise)
  canvasEl.addEventListener('mouseenter', () => {
    AppState.mouseOverCanvas = true;
    updateCanvasCursor();
  });
  canvasEl.addEventListener('mouseleave', () => {
    AppState.mouseOverCanvas = false;
    if (AppState.myCanvas?.elt) {
      AppState.myCanvas.elt.style.cursor = 'default';
    }
    // Without this, the scrubber/tooltip/map-cursor from the last hovered
    // position would stay stuck on screen until some unrelated redraw — see
    // mouseMoved() below for why hovering no longer keeps the loop running.
    redraw();
  });

  window.addEventListener('mouseup', () => {
    if (AppState.isDragging || AppState.isDraggingTimeline) {
      AppState.isDragging = false;
      AppState.isDraggingTimeline = false;
      updateCanvasCursor();
      redraw();
    }
  });
}

function updateCanvasCursor() {
  if (!AppState.myCanvas?.elt) return;
  let cur = 'default';
  if (AppState.isDragging || AppState.isDraggingTimeline) {
    cur = 'grabbing';
  } else if (
    AppState.mouseOverCanvas &&
    AppState.analyzer?.raw &&
    AppState.analyzer.raw.length > 0
  ) {
    if (
      GSRRenderer.isOverExclude(mouseX, mouseY) ||
      GSRRenderer.isOverPeak(mouseX, mouseY)
    ) {
      cur = 'pointer';
    } else if (
      mouseX >= GSR_CONST.MARGIN.left &&
      mouseX <= width - GSR_CONST.MARGIN.right &&
      mouseY >= AppState.yTimelineTop &&
      mouseY <= AppState.yTimelineBottom
    ) {
      cur = 'ew-resize';
    } else if (
      mouseX >= GSR_CONST.MARGIN.left &&
      mouseX <= width - GSR_CONST.MARGIN.right &&
      mouseY >= GSR_CONST.MARGIN.top &&
      mouseY <= AppState.yGraphBottom
    ) {
      cur = 'crosshair';
    }
  }
  AppState.myCanvas.elt.style.cursor = cur;
}

/**
 * True when a mouse/wheel event was aimed at the graph canvas itself. p5
 * listens on the whole page and measures mouseX/mouseY from the canvas
 * wherever the pointer is, so a press or wheel on whatever covers the canvas
 * (the map's full-screen overlay) would otherwise land on the hidden graph.
 * Calls without an event (tests, synthetic calls) count as on the canvas.
 */
function _eventOnCanvas(event) {
  const el = AppState.myCanvas?.elt;
  if (!el) return false;
  return !event?.target || event.target === el;
}

export function mousePressed(event) {
  if (!_eventOnCanvas(event)) return;
  if (AppState.analyzer.raw.length === 0) return;

  // Check for click on an on-canvas exclude ✕ / ＋ button — abort drag if hit
  if (GSRRenderer.checkExcludeHit(mouseX, mouseY)) {
    updateCanvasCursor();
    return;
  }

  // Check for click on a peak marker or vertical line — select if hit and abort drag
  if (GSRRenderer.checkPeakClick?.(mouseX, mouseY)) {
    updateCanvasCursor();
    redraw();
    return;
  }

  if (
    mouseX >= GSR_CONST.MARGIN.left &&
    mouseX <= width - GSR_CONST.MARGIN.right &&
    mouseY >= AppState.yTimelineTop &&
    mouseY <= AppState.yTimelineBottom
  ) {
    AppState.isDraggingTimeline = true;
    updateCanvasCursor();
    const clickTime = map(
      mouseX,
      GSR_CONST.MARGIN.left,
      width - GSR_CONST.MARGIN.right,
      AppState.timeAxisStart,
      AppState.totalDuration,
    );
    AppState.viewStartTime = AppState.clampViewStart(
      clickTime - AppState.viewDuration / 2,
    );
    redraw();
  } else if (
    mouseX >= GSR_CONST.MARGIN.left &&
    mouseX <= width - GSR_CONST.MARGIN.right &&
    mouseY >= GSR_CONST.MARGIN.top &&
    mouseY <= AppState.yGraphBottom
  ) {
    AppState.isDragging = true;
    AppState.dragStartMouseX = mouseX;
    AppState.dragStartViewStart = AppState.viewStartTime;
    updateCanvasCursor();
  }
}

export function mouseDragged() {
  if (AppState.isDraggingTimeline && AppState.analyzer.raw.length > 0) {
    updateCanvasCursor();
    const dragTime = map(
      mouseX,
      GSR_CONST.MARGIN.left,
      width - GSR_CONST.MARGIN.right,
      AppState.timeAxisStart,
      AppState.totalDuration,
    );
    AppState.viewStartTime = AppState.clampViewStart(
      dragTime - AppState.viewDuration / 2,
    );
    coalescedDragRedraw();
  } else if (AppState.isDragging && AppState.analyzer.raw.length > 0) {
    updateCanvasCursor();
    const mouseDx = mouseX - AppState.dragStartMouseX;
    const timePerPixel =
      AppState.viewDuration /
      (width - GSR_CONST.MARGIN.left - GSR_CONST.MARGIN.right);
    const timeShift = mouseDx * timePerPixel;

    AppState.viewStartTime = AppState.clampViewStart(
      AppState.dragStartViewStart - timeShift,
    );
    coalescedDragRedraw();
  }
}

export function mouseReleased() {
  AppState.isDragging = false;
  AppState.isDraggingTimeline = false;
  updateCanvasCursor();
}

export function mouseMoved() {
  if (AppState.mouseOverCanvas) {
    updateCanvasCursor();
    coalescedHoverRedraw();
  }
}

// Graph wheel zoom, in doublings of the view's length per pixel scrolled: a
// 100 px mouse-wheel notch is about ×1.15, and a trackpad's stream of small
// events adds up to the same for the same finger travel. A pinch (which the
// browser sends as a wheel with ctrlKey) is three times as fast, the same
// ratio as the map's wheel zoom (smooth_wheel_zoom.mjs). One event never
// zooms more than one doubling.
const GRAPH_WHEEL_RATE = 1 / 500;
const GRAPH_PINCH_RATE = 3 / 500;
const GRAPH_MAX_WHEEL_STEP = 1;
// deltaMode 1 = lines, 2 = pages (e.g. Firefox with some mice); 0 = pixels.
const WHEEL_LINE_PX = 16;

/**
 * What one wheel event over the graph does: { pan } (pixels to scroll the
 * view along the walk; positive = later) for a mostly-sideways scroll, or
 * { zoom } (factor to multiply the view's length by; below 1 = zoom in) for
 * a mostly-up/down one, or null when it doesn't move at all. `pagePx` is the
 * size of one "page" for page-mode wheels.
 */
function graphWheelStep(event, pagePx) {
  const unit =
    event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? pagePx : 1;
  const dx = (event.deltaX || 0) * unit;
  const dy = (event.deltaY || 0) * unit;
  if (Math.abs(dx) > Math.abs(dy)) return { pan: dx };
  if (!dy) return null;
  const rate = event.ctrlKey ? GRAPH_PINCH_RATE : GRAPH_WHEEL_RATE;
  const doublings = Math.max(
    -GRAPH_MAX_WHEEL_STEP,
    Math.min(GRAPH_MAX_WHEEL_STEP, dy * rate),
  );
  return { zoom: 2 ** doublings };
}

export function mouseWheel(event) {
  // p5 hears wheels anywhere on the page, with mouseX/mouseY measured from
  // the canvas even where something else covers it (the map's full-screen
  // overlay), so act only on wheels aimed at the canvas itself.
  if (!_eventOnCanvas(event)) return;
  if (
    mouseX >= GSR_CONST.MARGIN.left &&
    mouseX <= width - GSR_CONST.MARGIN.right &&
    mouseY >= GSR_CONST.MARGIN.top &&
    mouseY <= AppState.yGraphBottom
  ) {
    if (AppState.analyzer.raw.length === 0) return false;

    const plotWidth = width - GSR_CONST.MARGIN.left - GSR_CONST.MARGIN.right;
    const step = graphWheelStep(event, height);
    if (!step) return false;
    if (step.pan !== undefined) {
      AppState.viewStartTime = AppState.clampViewStart(
        AppState.viewStartTime + step.pan * (AppState.viewDuration / plotWidth),
      );
      coalescedZoomRedraw();
      return false;
    }

    const mouseTime = map(
      mouseX,
      GSR_CONST.MARGIN.left,
      width - GSR_CONST.MARGIN.right,
      AppState.viewStartTime,
      AppState.viewStartTime + AppState.viewDuration,
    );

    AppState.viewDuration = constrain(
      AppState.viewDuration * step.zoom,
      2.0,
      AppState.timeAxisSpan,
    );
    AppState.zoomFactor = AppState.timeAxisSpan / AppState.viewDuration;

    AppState.viewStartTime = AppState.clampViewStart(
      mouseTime -
        (mouseX - GSR_CONST.MARGIN.left) *
          (AppState.viewDuration /
            (width - GSR_CONST.MARGIN.left - GSR_CONST.MARGIN.right)),
    );

    coalescedZoomRedraw();
    return false;
  }
}
