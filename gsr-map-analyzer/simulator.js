/**
 * Data Simulation and Mock Signal Generation
 * Uses AppState for shared references.
 */

function loadDemoData() {
  var Fs = 10;
  var len = 120 * Fs;

  var csvRows = ["Time (s),Conductance (uS),Latitude,Longitude"];

  var lat = 51.5074;
  var lon = -0.1278;

  var baseline = 3.0;
  var activePeaks = [];

  var stimuli = [
    [12, 0.45],
    [32, 0.25],
    [50, 0.65],
    [75, 0.35],
    [95, 0.50]
  ];
  stimuli.push([99, 0.40]);

  for (var i = 0; i < len; i++) {
    var t = i / Fs;

    var tonicValue = baseline - 0.005 * t + 0.15 * Math.sin(t * 0.04);

    var phasicValue = 0;
    stimuli.forEach(function(stim) {
      var onsetTime = stim[0];
      var peakHeight = stim[1];
      if (t >= onsetTime) {
        var dt = t - onsetTime;
        var tauRise = 1.2;
        var tauDecay = 5.5;
        var tPeak = (tauRise * tauDecay / (tauDecay - tauRise)) * Math.log(tauDecay / tauRise);
        var norm = 1.0 / (Math.exp(-tPeak / tauDecay) - Math.exp(-tPeak / tauRise));
        var scrVal = peakHeight * norm * (Math.exp(-dt / tauDecay) - Math.exp(-dt / tauRise));
        if (scrVal > 0) phasicValue += scrVal;
      }
    });

    var noiseVal = randomGaussian(0, 0.003);

    var motionArtifact = 0;
    if (t >= 22.0 && t <= 22.6) {
      motionArtifact = 0.8 * Math.sin((t - 22.0) * Math.PI / 0.6);
    }
    if (t >= 65.1 && t <= 65.3) {
      motionArtifact = -1.2 * Math.sin((t - 65.1) * Math.PI / 0.2);
    }

    var latStr = "";
    var lonStr = "";
    if (i % 10 === 0) {
      lat += 0.000015 * Math.sin(t * 0.05) + 0.000012;
      lon += 0.000020 * Math.cos(t * 0.05) + 0.000006;
      latStr = lat.toFixed(6);
      lonStr = lon.toFixed(6);
    }

    var totalVal = tonicValue + phasicValue + noiseVal + motionArtifact;
    csvRows.push(t.toFixed(2) + "," + totalVal.toFixed(5) + "," + latStr + "," + lonStr);
  }

  var csvText = csvRows.join("\n");
  var file = { name: "demo_gsr_data.csv" };

  try {
    var tempAnalyzer = new GSRAnalyzer();
    tempAnalyzer.parseCSV(csvText);

    var trackId = 'track_demo_' + Date.now();
    var trackColor = AppState.getNextTrackColor();

    var filterParams = {
      medianSize: 1.0,
      lpfWindow: 0.8,
      tonicMethod: 'percentile',
      tonicWindow: 15,
      peakThreshold: 0.020
    };

    var newTrack = {
      id: trackId,
      name: file.name,
      color: trackColor,
      enabled: true,
      analyzer: tempAnalyzer,
      filterParams: filterParams
    };

    AppState.collectiveManager.addTrack(newTrack);
    // No need to call analyze() here — switchActiveTrack() → runAnalysis() does it

    switchActiveTrack(trackId);
    renderTrackList();

    setFileStatus('success', AppState.collectiveManager.tracks.length + ' Tracks Loaded');

    if (AppState.viewMode === 'collective') {
      updateCollectiveMap();
    }
  } catch (err) {
    alert("Error loading demo: " + err.message);
  }
}

function randomGaussian(mean, stdDev) {
  if (mean === undefined) mean = 0;
  if (stdDev === undefined) stdDev = 1;
  var u1 = Math.random();
  var u2 = Math.random();
  while (u1 <= 0.0000001) u1 = Math.random();
  var randStdNormal = Math.sqrt(-2.0 * Math.log(u1)) * Math.sin(2.0 * Math.PI * u2);
  return mean + stdDev * randStdNormal;
}
