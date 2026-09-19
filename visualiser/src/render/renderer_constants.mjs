// Copyright (c) 2026 Christian Nold
// Licensed under the Bio Mapping Community Licence 1.0.
// See LICENCE.md in the project root for terms.

/**
 * Shared styling constants and color helpers for the 2D canvas renderer.
 */

/**
 * Get peak quality color hex based on quality score.
 * High (≥0.7) → green #008f3c, Medium (≥0.4) → amber #e59e00, Low → red #d10024.
 * If alphaSuffix is provided (e.g. '20'), appends it for RGBA-style hex.
 */
export function getQualityColor(score, alphaSuffix) {
  const base = score >= 0.7 ? '#008f3c' : score >= 0.4 ? '#e59e00' : '#d10024';
  return alphaSuffix ? base + alphaSuffix : base;
}

/**
 * Get peak quality label string ('High', 'Med', 'Low') and percent.
 */
export function getQualityLabel(score) {
  const pct = Math.round(score * 100);
  const label = score >= 0.7 ? 'High' : score >= 0.4 ? 'Med' : 'Low';
  return { pct, label };
}

// Excluded-peak visual style constants
export const EXCLUDED_STYLE = {
  color: '#9a9a9a',
  lineColor: '#b0b0b0',
  lineAlpha: '3c',
  fillAlpha: '1a',
  dash: [2, 4],
  weight: 1.2,
  dotWeight: 1.5,
};

export const NORMAL_DASH = [3, 3];

export const EXCLUDE_BTN = {
  r: 5, // button radius
  offsetY: -8, // Y offset from yBottomU (bottom of upper graph)
  symbol: '\u2715', // ✕ character
};

export const PARK_EDGE_TOLERANCE_M = 15;
