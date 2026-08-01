const assert = require('assert');
const GSRFileSaver = require('../file_saver.js');

console.log("========================================");
console.log("GSR FILE SAVER TESTS");
console.log("========================================");

// Test 1: Module loaded properly
assert(typeof GSRFileSaver === 'object', 'GSRFileSaver should be an object');
assert(typeof GSRFileSaver.saveFile === 'function', 'saveFile should be a function');
console.log("  ✓ GSRFileSaver exports saveFile API");

// Test 2: Direct download fallback execution in non-browser env (Node.js)
(async () => {
  const result = await GSRFileSaver.saveFile("test,csv,data\n1,2,3", "test_track.csv");
  assert(result === true, 'saveFile returns true when falling back gracefully');
  console.log("  ✓ GSRFileSaver handles fallback gracefully");
  console.log("\nAll GSRFileSaver tests passed successfully!\n");
})();
