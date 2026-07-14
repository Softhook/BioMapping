/**
 * Overpass API Client for Bio Mapping.
 * Handles rate limits, backoffs, retries, and network queries.
 */
const OverpassClient = {
  overpassEndpoint: 'https://overpass-api.de/api/interpreter',

  // Rate-limit tracker
  _nextAllowedCallTime: null,

  buildQuery(bbox) {
    const b = `${bbox.minLat.toFixed(6)},${bbox.minLon.toFixed(6)},${bbox.maxLat.toFixed(6)},${bbox.maxLon.toFixed(6)}`;
    return `[out:json][timeout:180][maxsize:536870912];
(
  way["highway"](${b});
  way["building"](${b});
  relation["building"](${b});
  way["leisure"~"park|garden|nature_reserve|playground"](${b});
  way["landuse"~"grass|forest|meadow|recreation_ground|village_green|orchard"](${b});
  way["natural"~"wood|scrub|grassland|heath"](${b});
  relation["leisure"~"park|garden|nature_reserve|playground"](${b});
  relation["landuse"~"grass|forest|meadow|recreation_ground|village_green|orchard"](${b});
  relation["natural"~"wood|scrub|grassland|heath"](${b});
  way["natural"~"water|wetland"](${b});
  way["waterway"](${b});
  relation["natural"~"water|wetland"](${b});
  relation["waterway"](${b});
  node["amenity"](${b});
  way["amenity"](${b});
  node["shop"](${b});
  way["shop"](${b});
  node["highway"="bus_stop"](${b});
  node["natural"="tree"](${b});
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

  async fetchOSMData(bbox, onProgress) {
    if (onProgress) onProgress('Connecting to Overpass API...');

    const query = OverpassClient.buildQuery(bbox);

    // Honour global rate-limit cooldown before we even start
    await OverpassClient._enforceRateLimit(onProgress);

    const maxRetries = 3;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutMs = 200000;                       // 200 s network timeout
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch(OverpassClient.overpassEndpoint, {
          method: 'POST',
          body: 'data=' + encodeURIComponent(query),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          signal: controller.signal
        });

        clearTimeout(timeoutId);

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
      }
    }
  }
};
