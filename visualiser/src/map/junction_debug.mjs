/**
 * Junction debug overlay — draws every passage Junctions.classifyPassages
 * detects on the 2D map, so detection can be checked by eye.
 *
 * Ring colour = decision (turn / straight / reverse / ambiguous / control);
 * dot colour = kind, i.e. WHY it was flagged (choice / choice+change / change);
 * the ring sits where the walker was; the filled dot is the OSM node it was
 * matched to, joined by a thin line (a pavement walker can be ~15 m from the
 * road-centre node).  Uses
 * the same snapped points and radius as the Junction Turns analysis, and
 * never touches the per-track layer groups.  Enriched tracks only.
 */
import { AppState } from '../core/app_state.mjs';
import { GSRNotices } from '../core/notices.mjs';
import { OSMEnricher } from '../osm/osm_enrichment.mjs';
import { GSRStorage } from '../ui/storage.mjs';

const DECISION_COLOUR = {
  turn: '#e8590c',
  straight: '#1c7ed6',
  reverse: '#ae3ec9',
  ambiguous: '#868e96',
  control: '#2f9e44',
};

const KIND_COLOUR = {
  choice: '#e8590c',
  'choice+change': '#ae3ec9',
  change: '#1c7ed6',
  control: '#2f9e44',
};

const LEGEND_ROWS = {
  ring: [
    ['turn', 'turned'],
    ['straight', 'carried straight on'],
    ['reverse', 'walked back'],
    ['ambiguous', 'snapped and raw GPS disagree'],
    ['control', 'open-road control sample'],
  ],
  dot: [
    ['choice', 'choice: 3+ road-ends meet'],
    ['choice+change', 'choice and road character change'],
    ['change', 'road character change only'],
  ],
};

export const JunctionDebug = {
  _group: null,
  _legend: null,
  _on: false,

  isOn() {
    return this._on;
  },

  toggle(on) {
    this._on = !!on;
    this.refresh();
  },

  _analyzers() {
    if (AppState.viewMode === 'collective') {
      return (AppState.collectiveManager?.tracks || [])
        .filter((t) => t.visible !== false)
        .map((t) => ({ id: t.id, a: t.analyzer }));
    }
    return AppState.analyzer ? [{ id: 'current', a: AppState.analyzer }] : [];
  },

  _legendHtml() {
    const ring = ([k, label]) =>
      `<div><span style="display:inline-block;width:12px;height:12px;box-sizing:border-box;border:3px solid ${DECISION_COLOUR[k]};border-radius:50%;margin-right:6px;vertical-align:middle"></span>${label}</div>`;
    const dot = ([k, label]) =>
      `<div><span style="display:inline-block;width:8px;height:8px;background:${KIND_COLOUR[k]};border:1px solid #000;border-radius:50%;margin:0 8px 0 2px;vertical-align:middle"></span>${label}</div>`;
    return (
      '<b>Junctions (debug)</b><div style="margin-top:4px"><i>Ring = what the walker did</i></div>' +
      LEGEND_ROWS.ring.map(ring).join('') +
      '<div style="margin-top:4px"><i>Dot = why it was flagged</i></div>' +
      LEGEND_ROWS.dot.map(dot).join('') +
      '<div style="margin-top:4px;color:#555">Line joins the walker to the OSM node.</div>'
    );
  },

  _syncLegend(map) {
    if (this._legend) {
      this._legend.remove();
      this._legend = null;
    }
    if (!this._on) return;
    const legend = L.control({ position: 'bottomleft' });
    legend.onAdd = () => {
      const div = L.DomUtil.create('div', 'junction-debug-legend');
      div.style.cssText =
        'background:rgba(255,255,255,0.92);padding:8px 10px;border-radius:6px;font:12px/1.5 sans-serif;color:#222;box-shadow:0 1px 4px rgba(0,0,0,0.3)';
      div.innerHTML = this._legendHtml();
      return div;
    };
    legend.addTo(map);
    this._legend = legend;
  },

  /** Redraw (or clear) the overlay from the current tracks. */
  refresh() {
    const map = AppState.mapManager?.map;
    if (!map) return;
    this._syncLegend(map);
    if (this._group) {
      map.removeLayer(this._group);
      this._group = null;
    }
    if (!this._on) return;

    const { snapRadius } = GSRStorage.readEnrichmentRadii();
    const group = L.layerGroup();
    const drawnNodes = new Set();
    let total = 0;

    for (const { id, a } of this._analyzers()) {
      if (!a?.isEnriched || !a.osmGeoms?.ways) continue;
      const found = OSMEnricher.junctionPassages(a, snapRadius);
      if (!found) continue;
      const { pts, passages, nodes } = found;
      const describeWays = (key) =>
        [...(nodes.get(key)?.ways.values() || [])]
          .map((w) => {
            const t = w.tags || {};
            const sub = t.footway || t.service || t.cycleway || '';
            return GSRNotices.escapeHtml(
              `${t.highway}${sub ? `/${sub}` : ''} ${t.name || '(unnamed)'} #${w.id}`,
            );
          })
          .join('<br>&nbsp;&nbsp;');

      for (const p of passages) {
        const colour = DECISION_COLOUR[p.decision] || '#868e96';
        const kindColour = KIND_COLOUR[p.kind] || '#868e96';
        const at = pts[p.i];
        L.polyline(
          [
            [at.lat, at.lon],
            [p.lat, p.lon],
          ],
          { color: colour, weight: 1, opacity: 0.6, interactive: false },
        ).addTo(group);
        if (!drawnNodes.has(p.key)) {
          drawnNodes.add(p.key);
          L.circleMarker([p.lat, p.lon], {
            radius: 3,
            color: '#000',
            weight: 1,
            fillColor: kindColour,
            fillOpacity: 1,
            interactive: false,
          }).addTo(group);
        }
        const fmt = (v) => (v == null ? '–' : `${Math.round(v)}°`);
        L.circleMarker([at.lat, at.lon], {
          radius: 9,
          color: colour,
          weight: 3,
          fill: false,
        })
          .bindPopup(
            `<b>${p.decision}</b> (${p.kind})<br>` +
              `track ${id}, t=${Math.round(p.time)}<br>` +
              `degree ${p.degree}, turn ${fmt(p.turnAngleDeg)} ` +
              `(raw ${fmt(p.rawTurnAngleDeg)})<br>` +
              `in ${p.inClass ?? '–'} → out ${p.outClass ?? '–'}<br>` +
              `ways here:<br>&nbsp;&nbsp;${describeWays(p.key) || '–'}`,
          )
          .addTo(group);
        total++;
      }
    }
    group.addTo(map);
    this._group = group;
    console.info(`[JunctionDebug] ${total} passages drawn`);
  },
};
