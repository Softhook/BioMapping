/**
 * Overpass API Client for Bio Mapping.
 * Handles rate limits, backoffs, retries, mirror fallback, and network queries.
 */
const OverpassClient = {
  // Tried in order. Only a connection-level failure (the host itself
  // unreachable — DNS/TCP/CORS, surfaced by fetch() as a thrown TypeError,
  // never an HTTP status) falls through to the next one; a real HTTP error
  // from a live server (rate limit exhausted, malformed query, area too
  // large) would fail identically on every mirror, so it's reported
  // immediately instead of silently retried elsewhere.
  ENDPOINTS: [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ],
  // Kept for anything (tests, callers) that still reads the single-endpoint
  // shape; always the primary.
  get overpassEndpoint() { return OverpassClient.ENDPOINTS[0]; },

  // Rate-limit tracker. Shared across mirrors rather than per-endpoint —
  // simpler, and a conservative choice: many Overpass rate limits are
  // enforced by client IP rather than by which mirror you hit, so a 429 from
  // one is a reasonable (if imperfect) signal to also hold off on the other.
  _nextAllowedCallTime: null,

  buildQuery(bbox) {
    // A single global [bbox:...] setting (rather than repeating the same
    // area filter "(${b})" on all 20 clauses below) is the form Overpass QL
    // itself recommends for this shape of query — smaller request body, and
    // the server only has to resolve the bounding box once instead of once
    // per clause.
    //
    // No OsmCache.QUERY_VERSION bump for the green-tag edits either: `wetland`
    // was already fetched by the water clause, and `playground` polygons are
    // the only thing a stale cache now carries that fresh data would not —
    // and nothing consumes them any more (neither _isGreenSpace nor the OSM
    // overlay), so an old cached payload yields byte-identical enrichment.
    // Re-running "Retrieve Spatial Data" re-scores from whatever OSM JSON is
    // cached, which is all the green-tag change needs.
    const b = `${bbox.minLat.toFixed(6)},${bbox.minLon.toFixed(6)},${bbox.maxLat.toFixed(6)},${bbox.maxLon.toFixed(6)}`;
    return `[out:json][timeout:180][maxsize:536870912][bbox:${b}];
(
  way["highway"];
  way["building"];
  relation["building"];
  way["leisure"~"park|garden|nature_reserve"];
  way["landuse"~"grass|forest|meadow|recreation_ground|village_green|orchard"];
  way["natural"~"wood|scrub|grassland|heath|wetland"];
  relation["leisure"~"park|garden|nature_reserve"];
  relation["landuse"~"grass|forest|meadow|recreation_ground|village_green|orchard"];
  relation["natural"~"wood|scrub|grassland|heath|wetland"];
  way["natural"~"water|wetland"];
  way["waterway"];
  relation["natural"~"water|wetland"];
  relation["waterway"];
  node["amenity"];
  way["amenity"];
  node["shop"];
  way["shop"];
  node["highway"="bus_stop"];
  node["natural"="tree"];
  way["natural"="tree_row"];
  relation["natural"="tree_row"];
);
out body;
>;
out skel qt;`;
  },

  async _enforceRateLimit(onProgress) {
    const now = Date.now();
    if (OverpassClient._nextAllowedCallTime && now < OverpassClient._nextAllowedCallTime) {
      const wait = OverpassClient._nextAllowedCallTime - now;
      if (onProgress) {
        const sec = Math.ceil(wait / 1000);
        onProgress(`Rate-limited. Waiting ${sec}s before next request…`);
      }
      await new Promise(r => setTimeout(r, wait));
    }
  },

  _backoffMs(attempt, baseMs) {
    const linear = baseMs * Math.pow(2, attempt);
    const jitter = 1 + (Math.random() - 0.5) * 0.5; // 0.75 – 1.25
    return Math.round(linear * jitter);
  },

  _retryAfterMs(response, fallbackMs) {
    const val = response.headers.get('Retry-After');
    if (!val) return fallbackMs;
    const sec = parseInt(val, 10);
    if (!isNaN(sec) && sec > 0) return sec * 1000;
    return fallbackMs;
  },

  /**
   * Fetch OSM data, trying each of ENDPOINTS in turn. A connection-level
   * failure (the host itself unreachable, or persistently timing out even
   * after its own retries — never a real HTTP response) moves on to the
   * next mirror; any interpretable HTTP status from a live server is
   * reported immediately, since it would fail the same way everywhere.
   */
  async fetchOSMData(bbox, onProgress) {
    const query = OverpassClient.buildQuery(bbox);
    let lastErr = null;

    for (let i = 0; i < OverpassClient.ENDPOINTS.length; i++) {
      const endpoint = OverpassClient.ENDPOINTS[i];
      const isLastEndpoint = i === OverpassClient.ENDPOINTS.length - 1;
      try {
        return await OverpassClient._fetchFromEndpoint(endpoint, query, onProgress);
      } catch (err) {
        lastErr = err;
        const isConnectionFailure = (err instanceof TypeError) || err.name === 'AbortError';
        if (!isConnectionFailure || isLastEndpoint) throw err;
        const host = endpoint.split('/')[2];
        if (onProgress) onProgress(`${host} unreachable — trying a mirror…`);
      }
    }
    throw lastErr;
  },

  /**
   * Query a single Overpass endpoint, with rate-limit/backoff/retry on that
   * endpoint alone. Extracted from fetchOSMData so mirror fallback (above)
   * can call it once per candidate host.
   * @private
   */
  async _fetchFromEndpoint(endpoint, query, onProgress) {
    if (onProgress) onProgress('Connecting to Overpass API...');

    // Honour global rate-limit cooldown before we even start
    await OverpassClient._enforceRateLimit(onProgress);

    const maxRetries = 3;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let timeoutId;
      try {
        const controller = new AbortController();
        const timeoutMs = 200000;                       // 200 s network timeout
        timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch(endpoint, {
          method: 'POST',
          body: 'data=' + encodeURIComponent(query),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          signal: controller.signal
        });

        if (response.ok) {
          if (onProgress) onProgress('Parsing geographical payload...');
          return response.json();
        }

        if (response.status === 429 || response.status === 509) {
          const retryAfterMs = OverpassClient._retryAfterMs(response, 30000);
          OverpassClient._nextAllowedCallTime = Date.now() + retryAfterMs;

          if (attempt < maxRetries) {
            const msg = `Overpass API rate-limited (HTTP ${response.status}). ` +
              `Waiting ${Math.ceil(retryAfterMs / 1000)}s… (attempt ${attempt + 1}/${maxRetries})`;
            if (onProgress) onProgress(msg);
            await new Promise(r => setTimeout(r, retryAfterMs));
            continue;
          }

          throw new Error(
            `Overpass API rejected the request with HTTP ${response.status} (rate-limited). ` +
            `Try again in a few minutes, or use a smaller search radius / shorter track ` +
            `to reduce query size.`
          );
        }

        if (response.status === 504) {
          if (attempt < maxRetries) {
            const waitMs = OverpassClient._backoffMs(attempt, 5000);
            if (onProgress) {
              onProgress(
                `Overpass API timed out (504). Retrying in ${Math.ceil(waitMs / 1000)}s… ` +
                `(attempt ${attempt + 1}/${maxRetries})`
              );
            }
            await new Promise(r => setTimeout(r, waitMs));
            continue;
          }
          throw new Error(
            `Overpass API timed out after ${maxRetries + 1} attempts. ` +
            `The track covers too large an area. Try a shorter track, or split ` +
            `the session into smaller segments.`
          );
        }

        const hints = {
          400: 'The Overpass query was malformed. This is a bug — please report it.',
          403: 'Access denied by the Overpass API.',
          413: 'Request entity too large. Try a shorter track or smaller radius.',
          502: 'Overpass API gateway error. Try again later.',
          503: 'Overpass API is temporarily unavailable (maintenance or overload). Try again later.',
        };
        const hint = hints[response.status] ||
          `Unexpected HTTP ${response.status} from the Overpass API.`;
        throw new Error(hint);

      } catch (err) {
        if (err.name === 'AbortError' && attempt < maxRetries) {
          const waitMs = OverpassClient._backoffMs(attempt, 5000);
          if (onProgress) {
            onProgress(
              `Request timed out. Retrying in ${Math.ceil(waitMs / 1000)}s… ` +
              `(attempt ${attempt + 1}/${maxRetries})`
            );
          }
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timeoutId);
      }
    }
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { OverpassClient };
}
if (typeof window !== 'undefined') {
  window.OverpassClient = OverpassClient;
}
