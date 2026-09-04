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
    'https://overpass.private.coffee/api/interpreter',
  ],
  // Kept for anything (tests, callers) that still reads the single-endpoint
  // shape; always the primary.
  get overpassEndpoint() { return OverpassClient.ENDPOINTS[0]; },

  // Rate-limit tracker per endpoint (with backwards-compatible getter/setter)
  _endpointCooldowns: new Map(),

  get _nextAllowedCallTime() {
    return OverpassClient._endpointCooldowns.get(OverpassClient.overpassEndpoint) || null;
  },
  set _nextAllowedCallTime(val) {
    if (val == null) {
      OverpassClient._endpointCooldowns.clear();
    } else {
      OverpassClient._endpointCooldowns.set(OverpassClient.overpassEndpoint, val);
    }
  },

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

  async _enforceRateLimit(endpointOrProgress, onProgress) {
    let endpoint = OverpassClient.overpassEndpoint;
    let cb = onProgress;
    if (typeof endpointOrProgress === 'function') {
      cb = endpointOrProgress;
    } else if (typeof endpointOrProgress === 'string') {
      endpoint = endpointOrProgress;
    }
    const now = Date.now();
    const nextAllowed = OverpassClient._endpointCooldowns.get(endpoint);
    if (nextAllowed && now < nextAllowed) {
      const wait = nextAllowed - now;
      if (cb) {
        const sec = Math.ceil(wait / 1000);
        cb(`Rate-limited. Waiting ${sec}s before next request…`);
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
    const sec = parseFloat(val);
    if (!isNaN(sec) && sec > 0) return Math.round(sec * 1000);
    return fallbackMs;
  },

  /**
   * Determine if an error is a permanent query/client error that should fail fast
   * without trying other mirrors (e.g. malformed query syntax, body too large).
   * Server errors (502/503/504), rate limits (429), timeouts, stream truncations,
   * and connection drops are all server-specific and should fall through to a mirror.
   * @private
   */
  _isNonRetryableError(err) {
    if (!err || !err.message) return false;
    if (/malformed/i.test(err.message)) return true;
    if (/Access denied/i.test(err.message)) return true;
    if (/Request entity too large/i.test(err.message)) return true;
    return false;
  },

  /**
   * Fetch OSM data, trying each of ENDPOINTS in turn. Transient server failures,
   * timeouts, rate-limits, stream truncations, or connection failures fall through
   * to the next mirror; only permanent client errors (syntax/size) abort immediately.
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
        if (OverpassClient._isNonRetryableError(err) || isLastEndpoint) {
          throw err;
        }
        const host = endpoint.split('/')[2];
        if (onProgress) {
          onProgress(`${host} unreachable — trying a mirror…`);
        }
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

    // Honour endpoint-specific rate-limit cooldown before we even start
    await OverpassClient._enforceRateLimit(endpoint, onProgress);

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
          let json;
          try {
            json = await response.json();
          } catch (jsonErr) {
            throw new Error(`Invalid or truncated JSON response: ${jsonErr.message}`);
          }
          if (json && json.remark && /runtime error/i.test(json.remark)) {
            throw new Error(`Overpass server runtime error: ${json.remark}`);
          }
          return json;
        }

        if (response.status === 429 || response.status === 509) {
          const retryAfterMs = OverpassClient._retryAfterMs(response, 30000);
          OverpassClient._endpointCooldowns.set(endpoint, Date.now() + retryAfterMs);

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

        if (response.status === 502 || response.status === 503) {
          if (attempt < maxRetries) {
            const waitMs = OverpassClient._backoffMs(attempt, 2000);
            if (onProgress) {
              onProgress(
                `Overpass API unavailable (HTTP ${response.status}). Retrying in ${Math.ceil(waitMs / 1000)}s… ` +
                `(attempt ${attempt + 1}/${maxRetries})`
              );
            }
            await new Promise(r => setTimeout(r, waitMs));
            continue;
          }
          throw new Error(`Overpass API is temporarily unavailable (maintenance or overload). Try again later.`);
        }

        const hints = {
          400: 'The Overpass query was malformed. This is a bug — please report it.',
          403: 'Access denied by the Overpass API.',
          413: 'Request entity too large. Try a shorter track or smaller radius.',
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
