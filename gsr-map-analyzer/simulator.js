/**
 * Data Simulation and Mock Signal Generation
 */

/**
 * Generates highly realistic mock GSR data for demonstration
 */
function loadDemoData() {
  // 120 seconds of data @ 10Hz
  const Fs = 10;
  const len = 120 * Fs;
  
  let csvRows = ["Time (s),Conductance (uS),Latitude,Longitude"];
  
  // Starting point: London (Trafalgar Square)
  let lat = 51.5074;
  let lon = -0.1278;
  
  let baseline = 3.0; // Start at 3 uS SCL
  let activePeaks = []; // Peaks currently active in the generation
  
  // Define times and magnitudes of simulated stimuli responses
  // Format: [onset_time, peak_height]
  const stimuli = [
    [12, 0.45],  // Clean SCR peak
    [32, 0.25],  // Smaller SCR
    [50, 0.65],  // Large SCR response
    [75, 0.35],  // Standard SCR
    [95, 0.50]   // Double peak overlapping
  ];
  
  // We also simulate a second overlapping peak at 99s to test deconvolution-like splitting
  stimuli.push([99, 0.40]);
  
  // Generate samples
  for (let i = 0; i < len; i++) {
    const t = i / Fs;
    
    // 1. Simulate Slow Tonic drift (combination of exponential decay and slow sine wave)
    let tonicValue = baseline - 0.005 * t + 0.15 * Math.sin(t * 0.04);
    
    // 2. Simulate Phasic Peaks (SCRs)
    let phasicValue = 0;
    stimuli.forEach(([onsetTime, peakHeight]) => {
      if (t >= onsetTime) {
        const dt = t - onsetTime;
        // SCR model: double exponential function
        // rises in ~1.5s, decays with half-time of ~6s
        const tauRise = 1.2;
        const tauDecay = 5.5;
        // Peak normalization factor
        const tPeak = (tauRise * tauDecay / (tauDecay - tauRise)) * Math.log(tauDecay / tauRise);
        const norm = 1.0 / (Math.exp(-tPeak / tauDecay) - Math.exp(-tPeak / tauRise));
        
        const scrVal = peakHeight * norm * (Math.exp(-dt / tauDecay) - Math.exp(-dt / tauRise));
        if (scrVal > 0) {
          phasicValue += scrVal;
        }
      }
    });
  
    // 3. Add High Frequency Measurement Noise
    let noiseVal = randomGaussian(0, 0.003);
  
    // 4. Add Motion Artifact Spikes (brief, sharp jumps)
    // Motion spike at 22s and 65s
    let motionArtifact = 0;
    if (t >= 22.0 && t <= 22.6) {
      motionArtifact = 0.8 * Math.sin((t - 22.0) * Math.PI / 0.6); // smooth half-sine bump
    }
    if (t >= 65.1 && t <= 65.3) {
      motionArtifact = -1.2 * Math.sin((t - 65.1) * Math.PI / 0.2); // sharp contact drop
    }
  
    // Simulate walking path: update GPS coordinates at 1 Hz (once per 10 ticks)
    let latStr = "";
    let lonStr = "";
    if (i % 10 === 0) {
      lat += 0.000015 * Math.sin(t * 0.05) + 0.000012;
      lon += 0.000020 * Math.cos(t * 0.05) + 0.000006;
      latStr = lat.toFixed(6);
      lonStr = lon.toFixed(6);
    }
  
    const totalVal = tonicValue + phasicValue + noiseVal + motionArtifact;
    csvRows.push(`${t.toFixed(2)},${totalVal.toFixed(5)},${latStr},${lonStr}`);
  }
  
  const csvText = csvRows.join("\n");
  
  // Load mock file inside collective manager pipeline
  const file = { name: "demo_gsr_data.csv" };
  
  try {
    const tempAnalyzer = new GSRAnalyzer();
    tempAnalyzer.parseCSV(csvText);
  
    const trackId = 'track_demo_' + Date.now();
    const trackColor = getNextTrackColor();
  
    const filterParams = {
      medianSize: 1.0,
      lpfWindow: 0.8,
      tonicMethod: 'percentile',
      tonicWindow: 15,
      peakThreshold: 0.020
    };
  
    const newTrack = {
      id: trackId,
      name: file.name,
      color: trackColor,
      enabled: true,
      analyzer: tempAnalyzer,
      filterParams: filterParams
    };
  
    collectiveManager.addTrack(newTrack);
    tempAnalyzer.analyze(filterParams);
  
    switchActiveTrack(trackId);
    renderTrackList();
  
    const fileStatus = document.getElementById('fileStatus');
    fileStatus.querySelector('.status-dot').className = 'status-dot success';
    fileStatus.querySelector('.status-text').innerText = `${collectiveManager.tracks.length} Tracks Loaded`;
  
    if (viewMode === 'collective') {
      updateCollectiveMap();
    }
  } catch (err) {
    alert("Error loading demo: " + err.message);
  }
}
  
// Simple Gaussian Random number helper (Box-Muller transform)
function randomGaussian(mean = 0, stdDev = 1) {
  let u1 = Math.random();
  let u2 = Math.random();
  while (u1 <= 0.0000001) u1 = Math.random(); // avoid log(0)
  
  let randStdNormal = Math.sqrt(-2.0 * Math.log(u1)) * Math.sin(2.0 * Math.PI * u2);
  return mean + stdDev * randStdNormal;
}
