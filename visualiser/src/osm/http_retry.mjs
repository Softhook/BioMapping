/**
 * Retry timing shared by the Overpass and Copernicus NDVI fetchers.
 */

/**
 * Exponential backoff with ±25% random jitter, so parallel clients that
 * failed together don't retry in lockstep.
 * @param {number} attempt - Zero-based attempt count
 * @param {number} baseMs - Delay for the first retry
 * @returns {number} Wait in ms
 */
export function backoffMs(attempt, baseMs) {
  const linear = baseMs * 2 ** attempt;
  const jitter = 0.75 + Math.random() * 0.5;
  return Math.round(linear * jitter);
}

/**
 * The server's Retry-After header (in seconds) as ms, or the fallback when
 * it is missing, non-numeric or non-positive.
 * @param {Response|null} response
 * @param {number} fallbackMs
 * @returns {number}
 */
export function retryAfterMs(response, fallbackMs) {
  if (typeof response?.headers?.get !== 'function') return fallbackMs;
  const val = response.headers.get('Retry-After');
  if (!val) return fallbackMs;
  const sec = parseFloat(val);
  if (!isNaN(sec) && sec > 0) return Math.round(sec * 1000);
  return fallbackMs;
}
