/**
 * GSR File Saver Utility.
 * Uses native OS File System Access API (showSaveFilePicker) when available
 * to present a "Save Location" dialog box to the user, falling back to direct download.
 */
const GSRFileSaver = {
  /**
   * Save content (Blob, string, or ArrayBuffer) using save location dialog picker or direct download fallback.
   * @param {Blob|string|ArrayBuffer} content - Content to save
   * @param {string} suggestedName - Suggested default filename
   * @param {Array<{description: string, accept: Object}>} [types] - File types for save dialog picker
   * @returns {Promise<boolean>} True if saved or initiated fallback, false if cancelled by user
   */
  async saveFile(content, suggestedName, types) {
    let blob;
    if (content instanceof Blob) {
      blob = content;
    } else if (typeof content === 'string') {
      blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    } else {
      blob = new Blob([content]);
    }

    if (!types || types.length === 0) {
      const ext = suggestedName.includes('.') ? suggestedName.substring(suggestedName.lastIndexOf('.')).toLowerCase() : '';
      let mimeType = blob.type || 'application/octet-stream';
      let description = 'File';
      if (ext === '.csv') {
        mimeType = 'text/csv';
        description = 'CSV File (*.csv)';
      } else if (ext === '.json') {
        mimeType = 'application/json';
        description = 'JSON Preset File (*.json)';
      } else if (ext === '.png') {
        mimeType = 'image/png';
        description = 'PNG Image (*.png)';
      } else if (ext === '.svg') {
        mimeType = 'image/svg+xml';
        description = 'SVG Vector Map (*.svg)';
      } else if (ext === '.zip') {
        mimeType = 'application/zip';
        description = 'Zip Archive (*.zip)';
      }
      types = [{
        description,
        accept: { [mimeType]: [ext || '.*'] }
      }];
    }

    // 1. Try Native Browser OS Save As File Picker
    if (typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function') {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: suggestedName,
          types: types
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return true;
      } catch (err) {
        if (err.name === 'AbortError') {
          // User explicitly cancelled the Save location dialog box
          return false;
        }
        console.warn("showSaveFilePicker failed or restricted, falling back to download:", err);
      }
    }

    // 2. Direct download fallback
    if (typeof document !== 'undefined') {
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = suggestedName;
      link.style.visibility = "hidden";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    return true;
  }
};

if (typeof window !== 'undefined') {
  window.GSRFileSaver = GSRFileSaver;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = GSRFileSaver;
}
