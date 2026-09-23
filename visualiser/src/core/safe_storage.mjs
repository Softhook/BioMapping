/**
 * localStorage access that never throws. When the browser blocks site data
 * (Safari "Block all cookies", Firefox with cookies disabled) merely reading
 * `localStorage` throws a SecurityError, and outside a browser it doesn't
 * exist. Reads then return null and writes are dropped.
 */
export const SafeStorage = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch (_e) {
      return null;
    }
  },

  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (_e) {
      /* storage unavailable — the value just isn't remembered */
    }
  },

  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch (_e) {
      /* storage unavailable */
    }
  },
};
