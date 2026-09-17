/**
 * GSR sensor disconnect detection + straight-line repair.
 *
 * A finger-cuff disconnect reads as gsr_sensor.c's real open-circuit TIA
 * conversion — see GSR_VALID_MIN_NS in firmware/modules/gsr_sensor.h. With no
 * physiological signal driving the input, that reading floats to the same
 * value on every tick and comes out of the ADC bit-exact across many
 * consecutive samples (safe to compare with ===: it's the same decimal
 * literal re-parsed from the CSV each time, not two independently-computed
 * floats that happen to be close). Real skin conductance never does that:
 * even a perfectly calm baseline still has ADC/thermal noise moving the last
 * digit sample to sample.
 *
 * "N consecutive bit-identical samples" alone isn't quite a reliable enough
 * signature though — coarse quantisation could in principle repeat a couple
 * of samples at a perfectly ordinary signal level by chance. A real
 * disconnect is confirmed by a second, independent signal: the transition
 * into (or out of) it is a large jump, because the open-circuit floor sits
 * far from any real conductance/resistance reading. That confirmation check
 * is direction-agnostic (checks the ratio, not which side is bigger) so it
 * works whether the column reads low-when-disconnected (conductance) or
 * high-when-disconnected (resistance).
 *
 * A confirmed span is bridged with a straight line between the last good
 * sample before the drop and the first sample once the reconnect transient —
 * electrode-bounce blips plus an RC-style settling ramp, not just the flat
 * run itself — has damped back down. Stopping at the flat run's edge would
 * trade one artefact (a fake trough) for another (a fake spike from the
 * still-settling ramp). That settle search is bounded so it can never read
 * into a *different*, later disconnect's own flat run and mistake it for a
 * recovered baseline — see the `limit` handling below.
 *
 * A span open at either end of the recording (cuffs not yet attached when
 * recording starts, or still detached when it stops) has no good sample on
 * that side to draw a line from or to, so it's reported but left unrepaired.
 */

export function detectAndRepairGsrDisconnects(raw, opts = {}) {
  const {
    minFlatSeconds = 0.5, // shortest flat plateau treated as an open-circuit floor
    mergeGapSeconds = 3.0, // fold flat runs (and the bounce blips between them) within this long into one event
    settleFrac = 0.15, // frame-to-frame relative change below this counts as "settled"
    settleHoldSamples = 3, // consecutive settled transitions required before ending the reconnect transient
    maxSettleSeconds = 10.0, // hard cap on how far the settle search may roam past the flat run
    minJumpRatio = 3.0, // the boundary transition must look like a real disconnect, not a coincidental flat stretch at a normal signal level
  } = opts;

  const n = raw.length;
  const vals = new Array(n);
  for (let i = 0; i < n; i++) vals[i] = raw[i].val;

  const spans = [];
  if (n < 2) return { vals, spans };

  // 1. Exact-repeat runs (the open-circuit floor plateau), by elapsed time
  // rather than a fixed sample count — GSR is nominally 10 Hz but this keeps
  // the detector correct if that ever isn't exactly true.
  const flatRuns = findFlatRuns(raw, minFlatSeconds);
  if (flatRuns.length === 0) return { vals, spans };

  // 2. Merge runs that sit close together in time — initial electrode contact
  // bounces (make/break/make) produce several short floor runs a few samples
  // apart, punctuated by non-repeating partial-contact blips that would
  // otherwise slip through unrepaired between them.
  const merged = mergeCloseRuns(raw, flatRuns, mergeGapSeconds);

  // 3. Extend each merged span forward through the reconnect transient, then
  // confirm + bridge it (or report it unrepaired/unconfirmed).
  for (let k = 0; k < merged.length; k++) {
    const [start, flatEnd] = merged[k];

    // The settle search must never wander into the NEXT span's own flat run
    // and mistake its flatness for a recovered baseline — that produced a
    // silently wrong repair anchored inside still-disconnected data. `limit`
    // is the first index this span may not claim.
    const nextSpanStart = k + 1 < merged.length ? merged[k + 1][0] : n;

    const end = findSettleIndex(
      raw,
      flatEnd,
      nextSpanStart,
      maxSettleSeconds,
      settleFrac,
      settleHoldSamples,
    );

    const leftAnchor = start - 1;
    const rightAnchor = end + 1;
    // rightAnchor < nextSpanStart is guaranteed by the loop bound above, but
    // stated explicitly rather than only implied by it, so this stays
    // correct even if the loop's own bookkeeping changes later.
    const hasLeft = leftAnchor >= 0;
    const hasRight = rightAnchor < n && rightAnchor < nextSpanStart;

    const confirmed = isSpanConfirmed(
      raw,
      start,
      leftAnchor,
      rightAnchor,
      hasLeft,
      hasRight,
      minJumpRatio,
    );
    if (!confirmed) continue; // looks like a coincidental flat stretch at a normal level, not a disconnect

    const span = { startIdx: start, endIdx: end, repaired: false };
    const v0 = hasLeft ? raw[leftAnchor].val : NaN;
    const v1 = hasRight ? raw[rightAnchor].val : NaN;

    if (hasLeft && hasRight && Number.isFinite(v0) && Number.isFinite(v1)) {
      interpolateSpan(raw, vals, leftAnchor, rightAnchor, v0, v1);
      span.repaired = true;
    }
    spans.push(span);
  }

  return { vals, spans };
}

/**
 * Finds runs of bit-identical consecutive sample values lasting at least minFlatSeconds.
 */
function findFlatRuns(raw, minFlatSeconds) {
  const n = raw.length;
  const flatRuns = [];
  let i = 0;
  while (i < n) {
    let j = i + 1;
    while (j < n && raw[j].val === raw[i].val) j++;
    if (raw[j - 1].time - raw[i].time >= minFlatSeconds) {
      flatRuns.push([i, j - 1]);
    }
    i = j;
  }
  return flatRuns;
}

/**
 * Merges adjacent flat runs that sit within mergeGapSeconds of each other.
 */
function mergeCloseRuns(raw, flatRuns, mergeGapSeconds) {
  const merged = [flatRuns[0].slice()];
  for (let k = 1; k < flatRuns.length; k++) {
    const prev = merged[merged.length - 1];
    const cur = flatRuns[k];
    if (raw[cur[0]].time - raw[prev[1]].time <= mergeGapSeconds) {
      prev[1] = cur[1];
    } else {
      merged.push(cur.slice());
    }
  }
  return merged;
}

/**
 * Searches forward past flatEnd through electrode bounce and RC settling until
 * consecutive relative changes stay below settleFrac for settleHoldSamples, or until
 * nextSpanStart / maxSettleSeconds is hit.
 */
function findSettleIndex(
  raw,
  flatEnd,
  nextSpanStart,
  maxSettleSeconds,
  settleFrac,
  settleHoldSamples,
) {
  const flatEndTime = raw[flatEnd].time;
  let end = flatEnd;
  let settled = 0;

  while (
    end + 1 < nextSpanStart &&
    raw[end + 1].time - flatEndTime <= maxSettleSeconds
  ) {
    const scale = Math.max(
      Math.abs(raw[end].val),
      Math.abs(raw[end + 1].val),
      1e-9,
    );
    const relDelta = Math.abs(raw[end + 1].val - raw[end].val) / scale;
    end++;
    if (relDelta > settleFrac) {
      settled = 0;
    } else if (++settled >= settleHoldSamples) {
      break;
    }
  }

  return end;
}

/**
 * Confirms whether a flat run looks like an authentic disconnect (via jump ratio)
 * rather than a coincidental flat stretch at normal signal levels.
 */
function isSpanConfirmed(
  raw,
  start,
  leftAnchor,
  rightAnchor,
  hasLeft,
  hasRight,
  minJumpRatio,
) {
  if (!hasLeft && !hasRight) {
    // The whole reachable track is one flat value — unambiguous regardless of ratio
    return true;
  }
  const flatVal = raw[start].val;
  if (hasLeft && jumpRatio(flatVal, raw[leftAnchor].val) >= minJumpRatio) {
    return true;
  }
  if (hasRight && jumpRatio(flatVal, raw[rightAnchor].val) >= minJumpRatio) {
    return true;
  }
  return false;
}

/**
 * Bridges the gap between leftAnchor and rightAnchor using straight-line interpolation.
 */
function interpolateSpan(raw, vals, leftAnchor, rightAnchor, v0, v1) {
  const t0 = raw[leftAnchor].time;
  const t1 = raw[rightAnchor].time;
  const dt = t1 - t0;
  for (let idx = leftAnchor + 1; idx < rightAnchor; idx++) {
    const frac = dt > 0 ? (raw[idx].time - t0) / dt : 0;
    vals[idx] = v0 + (v1 - v0) * frac;
  }
}

/** Ratio between the larger and smaller magnitude of two values, direction-agnostic. */
function jumpRatio(a, b) {
  const lo = Math.min(Math.abs(a), Math.abs(b));
  const hi = Math.max(Math.abs(a), Math.abs(b));
  return hi / Math.max(lo, 1e-9);
}
