/**
 * GSR File Saver Utility.
 * Provides a unified API for exporting files using the native OS "Save Location" dialog box
 * (File System Access API `showSaveFilePicker`) with automatic fallback to direct download.
 */
const GSRFileSaver = {
  /**
   * Infer MIME type and description from suggested filename extension.
   * @param {string} filename
   * @returns {{mimeType: string, description: string, ext: string}}
   */
  getFormatInfo(filename) {
    const ext = filename.includes('.') ? filename.substring(filename.lastIndexOf('.')).toLowerCase() : '';
    switch (ext) {
      case '.csv':
        return { mimeType: 'text/csv', description: 'CSV File (*.csv)', ext };
      case '.json':
        return { mimeType: 'application/json', description: 'JSON File (*.json)', ext };
      case '.png':
        return { mimeType: 'image/png', description: 'PNG Image (*.png)', ext };
      case '.svg':
        return { mimeType: 'image/svg+xml', description: 'SVG Vector Map (*.svg)', ext };
      case '.zip':
        return { mimeType: 'application/zip', description: 'Zip Archive (*.zip)', ext };
      default:
        return { mimeType: 'application/octet-stream', description: 'File', ext };
    }
  },

  /**
   * Save content (Blob, string, data URL, or ArrayBuffer) using save location dialog picker or direct download fallback.
   * @param {Blob|string|ArrayBuffer} content - Content to save
   * @param {string} suggestedName - Suggested default filename (e.g., 'export.csv')
   * @param {Array<{description: string, accept: Object}>} [types] - Optional File System Access API picker file types filter
   * @returns {Promise<boolean>} True if saved or initiated fallback, false if cancelled by user
   */
  async saveFile(content, suggestedName, types) {
    const format = this.getFormatInfo(suggestedName);
    let blob;

    if (content instanceof Blob) {
      blob = content;
    } else if (typeof content === 'string') {
      if (content.startsWith('data:')) {
        const parts = content.split(',');
        const mimeMatch = parts[0].match(/^data:([^;]*)/);
        const mime = mimeMatch ? mimeMatch[1] : format.mimeType;
        const isBase64 = parts[0].includes(';base64');
        if (isBase64) {
          const bstr = atob(parts[1]);
          let n = bstr.length;
          const u8arr = new Uint8Array(n);
          while (n--) {
            u8arr[n] = bstr.charCodeAt(n);
          }
          blob = new Blob([u8arr], { type: mime });
        } else {
          const text = decodeURIComponent(parts[1]);
          blob = new Blob([text], { type: mime });
        }
      } else {
        const mime = format.mimeType !== 'application/octet-stream' ? `${format.mimeType};charset=utf-8` : 'text/plain;charset=utf-8';
        blob = new Blob([content], { type: mime });
      }
    } else {
      blob = new Blob([content], { type: format.mimeType });
    }

    if (!types || types.length === 0) {
      types = [{
        description: format.description,
        accept: { [format.mimeType]: [format.ext || '.*'] }
      }];
    }

    // 1. Native OS Save As File Picker Dialog Box
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
          // User explicitly cancelled the save location dialog box
          return false;
        }
        console.warn("showSaveFilePicker failed or restricted, using direct download fallback:", err);
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
