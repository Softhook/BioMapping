/**
 * GSRGlobeManager — the shared tour controls.
 * Class layer for GSRGlobeManager's tour controls
 * (`GSRGlobeTour extends GSRGlobeReplayTour`).
 *
 * The globe has two tours, each started from its own button:
 *   - the replay tour (globe3d/replay_tour.mjs — startReplayTour /
 *     toggleReplayTour): the walk redrawn at sped-up real time;
 *   - the hotspot tour (globe3d/hotspot_tour.mjs — startHotspotTour /
 *     toggleHotspotTour): a cinematic flight from hotspot to hotspot.
 * Only one runs at a time (starting one stops the other); `this._tourMode`
 * ('replay' | 'hotspot' | null) says which. Everything else — the stop that
 * flyToTrack/orbit/perspective/destroy call, and the Space / Left / Right
 * shortcuts — goes through the entry points here, which hand off to the
 * running tour's own implementation via TOUR_OPS.
 */
import { GSRGlobeReplayTour } from './replay_tour.mjs';

// Each tour's implementation of the shared controls. `step` takes ±1.
const TOUR_OPS = {
  replay: {
    stop: '_stopReplayTour',
    pause: '_pauseReplayTour',
    resume: '_resumeReplayTour',
    step: '_stepReplayTour',
  },
  hotspot: {
    stop: '_stopHotspotTour',
    pause: '_pauseHotspotTour',
    resume: '_resumeHotspotTour',
    step: '_stepHotspotTour',
  },
};

export class GSRGlobeTour extends GSRGlobeReplayTour {
  /** Run `op` on the running tour, if any. */
  _tourOp(op, ...args) {
    const ops = TOUR_OPS[this._tourMode];
    if (ops) this[ops[op]](...args);
  }

  /** Stop whichever tour is running (no-op when none is). */
  stopTour() {
    this._tourOp('stop');
  }

  /**
   * Pause the running tour. The replay freezes its clock (the camera stays
   * free to look around); the hotspot tour freezes its flight.
   */
  pauseTour() {
    if (!this._isTouring || this._isPaused) return;
    this._tourOp('pause');
  }

  resumeTour() {
    if (!this._isTouring || !this._isPaused) return;
    this._tourOp('resume');
  }

  /** Toggle pause/resume — the Space-bar shortcut's entry point. */
  toggleTourPause() {
    if (this._isPaused) this.resumeTour();
    else this.pauseTour();
    return this._isPaused;
  }

  /**
   * Left/Right-arrow shortcuts, implicitly un-pausing. The hotspot tour hops
   * to its next/previous waypoint; the replay jumps its clock to just before
   * the next/previous hotspot.
   */
  tourNext() {
    if (this._isTouring) this._tourOp('step', 1);
  }

  tourPrevious() {
    if (this._isTouring) this._tourOp('step', -1);
  }
}
