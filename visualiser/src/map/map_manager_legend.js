/**
 * GSRMapManager — the bottom-right map legend. Prototype-augment split from
 * map.js: loaded immediately after map.js, adds these methods to
 * GSRMapManager.prototype.
 *
 * `_initLegend()` mounts an L.Control; `updateLegend()` rewrites its inner HTML
 * from `buildLegendHtml()`, which reads the current colouring metric / data
 * range / view mode off instance state (this.activeColoringMetric,
 * this._legendMinVal / _legendMaxVal / _legendUniqueVals,
 * this._collectiveTopographySource, this.showRFFluid / rfFluidRenderer /
 * hasRfData). `buildLegendHtml()` is also called cross-file by
 * globe3d_view.js._updateLegend so the 3D globe shows the identical legend.
 *
 * Depends on the globals L, AppState, GSR_CONST and MapColors (resolved at call
 * time).
 */
Object.assign(GSRMapManager.prototype, {

  /**
   * Initialise the Leaflet legend control in the bottom-right corner.
   */
  _initLegend() {
    const LegendControl = L.Control.extend({
      onAdd: () => {
        const div = L.DomUtil.create('div', 'map-legend');
        div.innerHTML = '<div class="legend-title">GSR Signal</div><div class="legend-scale"><div class="legend-gradient" style="background: linear-gradient(90deg, hsl(120,90%,50%), hsl(60,90%,50%), hsl(0,90%,50%));"></div><div class="legend-labels"><span>Low</span><span>High</span></div></div>';
        return div;
      }
    });
    this._legendControl = new LegendControl({ position: 'bottomright' });
    this._legendControl.addTo(this.map);
  },

  /**
   * Update the legend to reflect the current colouring metric and data range.
   */
  updateLegend() {
    if (!this._legendControl) return;
    const el = this._legendControl.getContainer();
    if (!el) return;
    el.innerHTML = this.buildLegendHtml();
  },

  /**
   * Build the legend's inner HTML for the current colouring metric / data range /
   * view mode. Split out of updateLegend() so the 3D globe can render the exact
   * same legend (see globe3d_view.js _updateLegend).
   * @returns {string}
   */
  buildLegendHtml() {
    const isCollective = (typeof AppState !== 'undefined' && AppState.viewMode === 'collective');
    let html = '';

    if (isCollective) {
      const topoSource = this._collectiveTopographySource || 'phasic';
      const topoCfg = (typeof GSR_CONST !== 'undefined' && GSR_CONST.TOPOGRAPHY_SOURCES && GSR_CONST.TOPOGRAPHY_SOURCES[topoSource]) || null;
      const title = (topoCfg && topoCfg.label) || 'Topography';
      const unit = (topoCfg && topoCfg.unit !== undefined) ? topoCfg.unit : ' μS';

      const minV = this._legendMinVal;
      const maxV = this._legendMaxVal;

      const gradient = 'linear-gradient(90deg, hsl(120,90%,50%), hsl(60,90%,50%), hsl(0,90%,50%))';

      const fmt = (v) => {
        if (v >= 100) return v.toFixed(0);
        if (v >= 1) return v.toFixed(1);
        return v.toFixed(3);
      };

      const leftLabel  = fmt(minV) + unit;
      const rightLabel = fmt(maxV) + unit;

      html = `
        <div class="legend-title">${title}</div>
        <div class="legend-scale">
          <div class="legend-gradient" style="background:${gradient}"></div>
          <div class="legend-labels"><span>${leftLabel}</span><span>${rightLabel}</span></div>
        </div>`;
    } else {
      const metric = this.activeColoringMetric || 'gsr';

      // OSM entries (roadClass..amenityCount) come from the shared
      // GSR_CONST.OSM_METRICS table (constants.js) — single source of truth
      // for the key<->field<->label mapping, also used by map.js's
      // _getMetricKey() and ui.js's correlation dashboard.
      const metricNames = {
        'gsr':              'GSR Signal (Raw)',
        'phasic':           'Phasic (SCR)',
        'tonic':            'Tonic Baseline (SCL)',
        'peakDensity':      'Peak Density (NS-SCR)',
        'phasicAUC':        'Phasic AUC (ISCR)',
        'arousalIndex':     'Combined Arousal Index',
        'triIndex':         'Tri Index',
        'em_fog':           'EM Fog Index (0-100)',
        'hdopQuality':      'GPS Accuracy (HDOP)'
      };
      GSR_CONST.OSM_METRICS.forEach(m => { metricNames[m.key] = m.label; });

      const title = metricNames[metric] || metric;

      if (metric === 'roadClass') {
        const allRoadLabels = MapColors.ROAD_COLORS;
        html = `<div class="legend-title">${title}</div><div class="legend-swatches">`;
        let count = 0;
        for (const [name, color] of Object.entries(allRoadLabels)) {
          if (this._legendUniqueVals && !this._legendUniqueVals.has(name)) continue;
          html += `<div class="legend-swatch-row"><span class="legend-swatch" style="background:${color}"></span>${name}</div>`;
          count++;
        }
        if (count === 0) html += '<div class="legend-swatch-row" style="color:#999">No data</div>';
        html += '</div>';
      } else if (metric === 'inPark') {
        const hasYes = this._legendUniqueVals && this._legendUniqueVals.has(1);
        const hasNo  = this._legendUniqueVals && this._legendUniqueVals.has(0);
        html = `<div class="legend-title">${title}</div><div class="legend-swatches">`;
        if (hasYes) html += '<div class="legend-swatch-row"><span class="legend-swatch" style="background:#00e575"></span>Yes</div>';
        if (hasNo)  html += '<div class="legend-swatch-row"><span class="legend-swatch" style="background:#666666"></span>No</div>';
        if (!hasYes && !hasNo) html += '<div class="legend-swatch-row" style="color:#999">No data</div>';
        html += '</div>';
      } else {
        // Continuous metrics — build gradient bar
        const minV = this._legendMinVal;
        const maxV = this._legendMaxVal;

        let gradient;
        switch (metric) {
          case 'greenPct':
            gradient = 'linear-gradient(90deg, hsl(30,80%,45%), hsl(130,80%,45%))';
            break;
          case 'buildingDensity':
            gradient = 'linear-gradient(90deg, hsl(120,85%,50%), hsl(60,85%,50%), hsl(0,85%,50%))';
            break;
          case 'distMajorRoad':
            gradient = 'linear-gradient(90deg, hsl(0,85%,50%), hsl(60,85%,50%), hsl(120,85%,50%))';
            break;
          case 'distWater':
            gradient = 'linear-gradient(90deg, hsl(200,80%,45%), hsl(100,80%,45%), hsl(30,80%,45%))';
            break;
          case 'treeDensity':
            gradient = 'linear-gradient(90deg, hsl(60,30%,45%), hsl(140,90%,45%))';
            break;
          case 'amenityCount':
            gradient = 'linear-gradient(90deg, hsl(240,85%,55%), hsl(120,85%,55%), hsl(0,85%,55%))';
            break;
          case 'em_fog':
            gradient = 'linear-gradient(90deg, hsl(220,90%,55%), hsl(300,90%,55%))';
            break;
          case 'hdopQuality':
            // Gradient left = best accuracy (green), right = worst (red)
            gradient = 'linear-gradient(90deg, hsl(120,90%,45%), hsl(60,90%,45%), hsl(0,90%,45%))';
            break;
          default: // gsr
            gradient = 'linear-gradient(90deg, hsl(120,90%,50%), hsl(60,90%,50%), hsl(0,90%,50%))';
            break;
        }

        // Format min/max nicely
        const fmt = (v) => {
          if (v >= 100) return v.toFixed(0);
          if (v >= 1) return v.toFixed(1);
          return v.toFixed(3);
        };

        const leftLabel  = metric === 'hdopQuality' ? `HDOP ${fmt(minV)} (best)` : fmt(minV);
        const rightLabel = metric === 'hdopQuality' ? `HDOP ${fmt(maxV)} (worst)` : fmt(maxV);

        html = `
          <div class="legend-title">${title}</div>
          <div class="legend-scale">
            <div class="legend-gradient" style="background:${gradient}"></div>
            <div class="legend-labels"><span>${leftLabel}</span><span>${rightLabel}</span></div>
          </div>`;
      }
    }

    // Append RF Fluid Legend if active and active track has RF data:
    if (this.showRFFluid && this.rfFluidRenderer && this.hasRfData) {
      const rfMode = this.rfFluidRenderer.options.mode;
      let rfHtml = '';
      if (rfMode === 'triband') {
        rfHtml = `
          <hr style="margin: 8px 0; border: 0; border-top: 1px dashed #ccc;" />
          <div class="legend-title" style="margin-bottom: 6px;">RF Fluid (Tri-Band)</div>
          <div class="legend-swatches">
            <div class="legend-swatch-row">
              <span class="legend-swatch" style="background:#ff0000; border-radius:3px;"></span>
              815 MHz (LTE)
            </div>
            <div class="legend-swatch-row">
              <span class="legend-swatch" style="background:#00ff00; border-radius:3px;"></span>
              868 MHz (Grid)
            </div>
            <div class="legend-swatch-row">
              <span class="legend-swatch" style="background:#0000ff; border-radius:3px;"></span>
              915 MHz (ISM)
            </div>
          </div>`;
      } else if (rfMode === '815') {
        rfHtml = `
          <hr style="margin: 8px 0; border: 0; border-top: 1px dashed #ccc;" />
          <div class="legend-title" style="margin-bottom: 6px;">RF Fluid (815 MHz)</div>
          <div class="legend-swatches">
            <div class="legend-swatch-row">
              <span class="legend-swatch" style="background:#ff0000; border-radius:3px;"></span>
              815 MHz Active
            </div>
          </div>`;
      } else if (rfMode === '868') {
        rfHtml = `
          <hr style="margin: 8px 0; border: 0; border-top: 1px dashed #ccc;" />
          <div class="legend-title" style="margin-bottom: 6px;">RF Fluid (868 MHz)</div>
          <div class="legend-swatches">
            <div class="legend-swatch-row">
              <span class="legend-swatch" style="background:#00ff00; border-radius:3px;"></span>
              868 MHz Active
            </div>
          </div>`;
      } else if (rfMode === '915') {
        rfHtml = `
          <hr style="margin: 8px 0; border: 0; border-top: 1px dashed #ccc;" />
          <div class="legend-title" style="margin-bottom: 6px;">RF Fluid (915 MHz)</div>
          <div class="legend-swatches">
            <div class="legend-swatch-row">
              <span class="legend-swatch" style="background:#0000ff; border-radius:3px;"></span>
              915 MHz Active
            </div>
          </div>`;
      } else if (rfMode === 'fog') {
        rfHtml = `
          <hr style="margin: 8px 0; border: 0; border-top: 1px dashed #ccc;" />
          <div class="legend-title" style="margin-bottom: 6px;">EM Fog Intensity</div>
          <div class="legend-scale">
            <div class="legend-gradient" style="background: linear-gradient(90deg, #0000ff, #ff0000);"></div>
            <div class="legend-labels"><span>Low</span><span>High</span></div>
          </div>`;
      }
      html += rfHtml;
    }

    return html;
  }

});
