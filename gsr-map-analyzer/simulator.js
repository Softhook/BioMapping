/**
 * Data Simulation and Mock Signal Generation
 * Uses AppState for shared references.
 */

const GSRSimulator = {
  loadDemoData() {
    const Fs = 10;
    const len = 120 * Fs;

    const csvRows = ["Time (s),Conductance (uS),Latitude,Longitude"];

    let lat = 51.5074;
    let lon = -0.1278;

    const baseline = 3.0;

    const stimuli = [
      [12, 0.45],
      [32, 0.25],
      [50, 0.65],
      [75, 0.35],
      [95, 0.50]
    ];
    stimuli.push([99, 0.40]);

    for (let i = 0; i < len; i++) {
      const t = i / Fs;

      const tonicValue = baseline - 0.005 * t + 0.15 * Math.sin(t * 0.04);

      let phasicValue = 0;
      stimuli.forEach(stim => {
        const onsetTime = stim[0];
        const peakHeight = stim[1];
        if (t >= onsetTime) {
          const dt = t - onsetTime;
          const tauRise = 1.2;
          const tauDecay = 5.5;
          const tPeak = (tauRise * tauDecay / (tauDecay - tauRise)) * Math.log(tauDecay / tauRise);
          const norm = 1.0 / (Math.exp(-tPeak / tauDecay) - Math.exp(-tPeak / tauRise));
          const scrVal = peakHeight * norm * (Math.exp(-dt / tauDecay) - Math.exp(-dt / tauRise));
          if (scrVal > 0) phasicValue += scrVal;
        }
      });

      const noiseVal = randomGaussian(0, 0.003);

      let motionArtifact = 0;
      if (t >= 22.0 && t <= 22.6) {
        motionArtifact = 0.8 * Math.sin((t - 22.0) * Math.PI / 0.6);
      }
      if (t >= 65.1 && t <= 65.3) {
        motionArtifact = -1.2 * Math.sin((t - 65.1) * Math.PI / 0.2);
      }

      let latStr = "";
      let lonStr = "";
      if (i % 10 === 0) {
        lat += 0.000015 * Math.sin(t * 0.05) + 0.000012;
        lon += 0.000020 * Math.cos(t * 0.05) + 0.000006;
        latStr = lat.toFixed(6);
        lonStr = lon.toFixed(6);
      }

      const totalVal = tonicValue + phasicValue + noiseVal + motionArtifact;
      csvRows.push(t.toFixed(2) + "," + totalVal.toFixed(5) + "," + latStr + "," + lonStr);
    }

    const csvText = csvRows.join("\n");
    const file = { name: "demo_gsr_data.csv" };

    try {
      const tempAnalyzer = new GSRAnalyzer();
      tempAnalyzer.parseCSV(csvText);

      const trackId = 'track_demo_' + Date.now();
      const trackColor = AppState.getNextTrackColor();

      const filterParams = GSRStorage.readGsrSliderValues();
      const gpsFilterParams = GSRStorage.readGpsSliderValues();

      const newTrack = {
        id: trackId,
        name: file.name,
        color: trackColor,
        enabled: true,
        analyzer: tempAnalyzer,
        filterParams: filterParams,
        gpsFilterParams: gpsFilterParams
      };

      AppState.collectiveManager.addTrack(newTrack);
      // No need to call analyze() here — switchActiveTrack() → runAnalysis() does it

      GSRTrackManager.switchActiveTrack(trackId);
      GSRTrackManager.renderTrackList();

      GSRTrackManager.setFileStatus('success', AppState.collectiveManager.tracks.length + ' Tracks Loaded');

      if (AppState.viewMode === 'collective') {
        GSRUI.updateCollectiveMap();
      }
    } catch (err) {
      alert("Error loading demo: " + err.message);
    }
  }
};
// randomGaussian is provided by p5.js — the custom Box-Muller impl was removed
