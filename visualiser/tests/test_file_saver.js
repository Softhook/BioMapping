/**
 * Unit tests for file_saver.js (GSRFileSaver) — filename→MIME inference and
 * the Blob/string/data-URL/ArrayBuffer save-content normalization logic.
 *
 * showSaveFilePicker() (the File System Access API path) isn't available in
 * Node — those branches are exercised with a manual `window.showSaveFilePicker`
 * stub. The plain download-link fallback needs `document`/`URL.createObjectURL`;
 * those are stubbed minimally too, without pulling in jsdom.
 *
 * Run: node --test tests/test_file_saver.js
 */

const assert = require('assert');
const test = require('node:test');

const GSRFileSaver = require('../src/core/file_saver.js');

// ── getFormatInfo ─────────────────────────────────────────────────────────
test('getFormatInfo: recognises every explicitly-supported extension', () => {
  assert.deepStrictEqual(GSRFileSaver.getFormatInfo('a.csv'), { mimeType: 'text/csv', description: 'CSV File (*.csv)', ext: '.csv' });
  assert.deepStrictEqual(GSRFileSaver.getFormatInfo('a.json'), { mimeType: 'application/json', description: 'JSON File (*.json)', ext: '.json' });
  assert.deepStrictEqual(GSRFileSaver.getFormatInfo('a.png'), { mimeType: 'image/png', description: 'PNG Image (*.png)', ext: '.png' });
  assert.deepStrictEqual(GSRFileSaver.getFormatInfo('a.svg'), { mimeType: 'image/svg+xml', description: 'SVG Vector Map (*.svg)', ext: '.svg' });
  assert.deepStrictEqual(GSRFileSaver.getFormatInfo('a.zip'), { mimeType: 'application/zip', description: 'Zip Archive (*.zip)', ext: '.zip' });
});

test('getFormatInfo: is case-insensitive on the extension', () => {
  assert.strictEqual(GSRFileSaver.getFormatInfo('a.CSV').mimeType, 'text/csv');
  assert.strictEqual(GSRFileSaver.getFormatInfo('a.PnG').mimeType, 'image/png');
});

test('getFormatInfo: unknown/missing extension falls back to application/octet-stream', () => {
  assert.deepStrictEqual(GSRFileSaver.getFormatInfo('a.xyz'), { mimeType: 'application/octet-stream', description: 'File', ext: '.xyz' });
  assert.deepStrictEqual(GSRFileSaver.getFormatInfo('noextension'), { mimeType: 'application/octet-stream', description: 'File', ext: '' });
});

test('getFormatInfo: uses the LAST dot for filenames with multiple dots', () => {
  assert.strictEqual(GSRFileSaver.getFormatInfo('my.track.v2.csv').ext, '.csv');
});

// ── saveFile: content normalization (no window.showSaveFilePicker, no document → returns true, no-op download) ──
test('saveFile: plain string content resolves true (fallback path, no DOM in Node)', async () => {
  const result = await GSRFileSaver.saveFile('a,b,c\n1,2,3', 'test_track.csv');
  assert.strictEqual(result, true);
});

test('saveFile: base64 data URL is decoded to a Blob without throwing', async () => {
  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const result = await GSRFileSaver.saveFile(dataUrl, 'test_chart.png');
  assert.strictEqual(result, true);
});

test('saveFile: non-base64 (percent-encoded) data URL is decoded to a Blob with the correct MIME type', async () => {
  // Regression test: a data URL with no ";base64"/";charset" suffix (no literal
  // ";" before the comma) used to fail the mime-sniffing regex entirely and
  // silently fall back to the extension-guessed type instead of "text/plain".
  let written = null;
  global.window = {
    showSaveFilePicker: async () => ({
      createWritable: async () => ({
        write: async (blob) => { written = blob; },
        close: async () => {},
      }),
    }),
  };
  const dataUrl = 'data:text/plain,' + encodeURIComponent('hello world');
  const result = await GSRFileSaver.saveFile(dataUrl, 'note.txt');
  assert.strictEqual(result, true);
  assert.ok(written, 'blob should have been written via the picker handle');
  assert.strictEqual(written.type, 'text/plain');
  delete global.window;
});

test('saveFile: Blob content is used as-is', async () => {
  const blob = new Blob(['blob content'], { type: 'text/plain' });
  const result = await GSRFileSaver.saveFile(blob, 'file.txt');
  assert.strictEqual(result, true);
});

test('saveFile: ArrayBuffer content (neither Blob nor string) is wrapped in a Blob', async () => {
  const buf = new TextEncoder().encode('binary-ish').buffer;
  const result = await GSRFileSaver.saveFile(buf, 'file.bin');
  assert.strictEqual(result, true);
});

// ── saveFile: File System Access API path (window.showSaveFilePicker) ────
test('saveFile: uses window.showSaveFilePicker when available and writes the blob', async () => {
  let written = null;
  global.window = {
    showSaveFilePicker: async (opts) => {
      assert.strictEqual(opts.suggestedName, 'export.csv');
      return {
        createWritable: async () => ({
          write: async (blob) => { written = blob; },
          close: async () => {},
        }),
      };
    },
  };
  const result = await GSRFileSaver.saveFile('a,b\n1,2', 'export.csv');
  assert.strictEqual(result, true);
  assert.ok(written, 'blob should have been written via the picker handle');
  delete global.window;
});

test('saveFile: showSaveFilePicker AbortError (user cancelled) returns false, no fallback download attempted', async () => {
  global.window = {
    showSaveFilePicker: async () => {
      const err = new Error('The user aborted a request.');
      err.name = 'AbortError';
      throw err;
    },
  };
  const result = await GSRFileSaver.saveFile('a,b\n1,2', 'export.csv');
  assert.strictEqual(result, false);
  delete global.window;
});

test('saveFile: a non-abort picker error falls back to direct download instead of rejecting', async () => {
  const created = [];
  global.window = {
    showSaveFilePicker: async () => { throw new Error('picker not permitted in this context'); },
  };
  global.document = {
    createElement: (tag) => {
      const el = { tag, style: {}, clicked: false, click() { this.clicked = true; } };
      return el;
    },
    body: {
      appendChild: (el) => created.push({ action: 'append', el }),
      removeChild: (el) => created.push({ action: 'remove', el }),
    },
  };
  global.URL.createObjectURL = global.URL.createObjectURL || (() => 'blob:fake-url');
  global.URL.revokeObjectURL = global.URL.revokeObjectURL || (() => {});

  const result = await GSRFileSaver.saveFile('a,b\n1,2', 'export.csv');
  assert.strictEqual(result, true, 'should fall through to the download-link path and still resolve true');
  assert.strictEqual(created.length, 2, 'the DOM fallback should actually have appended and removed a download link');
  assert.strictEqual(created[0].el.clicked, true, 'the fallback link should have been clicked to trigger the download');

  delete global.window;
  delete global.document;
});

test('saveFile: custom `types` argument is passed straight through to showSaveFilePicker without being overridden', async () => {
  const customTypes = [{ description: 'Custom', accept: { 'text/custom': ['.custom'] } }];
  let receivedTypes = null;
  global.window = {
    showSaveFilePicker: async (opts) => {
      receivedTypes = opts.types;
      return { createWritable: async () => ({ write: async () => {}, close: async () => {} }) };
    },
  };
  await GSRFileSaver.saveFile('data', 'export.custom', customTypes);
  assert.strictEqual(receivedTypes, customTypes);
  delete global.window;
});

// ── saveFile: direct-download fallback DOM interaction ────────────────────
test('saveFile: falls back to a temporary <a download> link when no File System Access API is present', async () => {
  const created = [];
  global.document = {
    createElement: (tag) => {
      const el = { tag, style: {}, clicked: false, click() { this.clicked = true; } };
      return el;
    },
    body: {
      appendChild: (el) => created.push({ action: 'append', el }),
      removeChild: (el) => created.push({ action: 'remove', el }),
    },
  };
  global.URL.createObjectURL = global.URL.createObjectURL || (() => 'blob:fake-url');
  global.URL.revokeObjectURL = global.URL.revokeObjectURL || (() => {});

  const result = await GSRFileSaver.saveFile('a,b\n1,2', 'download_test.csv');
  assert.strictEqual(result, true);
  assert.strictEqual(created.length, 2, 'link should be appended then removed');
  assert.strictEqual(created[0].action, 'append');
  assert.strictEqual(created[0].el.download, 'download_test.csv');
  assert.strictEqual(created[0].el.clicked, true);
  assert.strictEqual(created[1].action, 'remove');

  delete global.document;
});
