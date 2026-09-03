/**
 * IndexedDB-backed cache for Overpass API responses.
 *
 * Reduces repeat calls to the public Overpass API when enriching multiple
 * tracks that cover the same, or an overlapping, geographic area (e.g.
 * several walks around the same neighbourhood). IndexedDB is used instead
 * of localStorage because Overpass JSON payloads for a track's bounding
 * box can run into several MB, comfortably past localStorage's ~5-10MB
 * per-origin quota. No server or external database is involved — this is
 * purely local browser storage.
 *
 * Storage layout — two object stores, not one:
 *   - META_STORE holds one small record per cached area: {id, bbox,
 *     queryVersion, fetchedAt, lastAccess}.
 *   - DATA_STORE holds the (potentially several-MB) Overpass JSON payload
 *     for that same id.
 *   Every cache-matching decision (does anything contain this bbox? does
 *   anything overlap it? which entry is least-recently-used?) only needs
 *   the metadata. Keeping the data blobs in a separate store means those
 *   decisions read a handful of small records instead of deserializing
 *   every cached payload on every single enrich click — the metadata
 *   table stays cheap to scan no matter how large the cached payloads
 *   get. The actual data blob is only ever fetched once, by id, after a
 *   specific entry has already been chosen.
 *
 * Design:
 *   - Cache lookups are NOT an exact bbox match. A lookup for `bbox`
 *     succeeds if any stored entry's bbox fully CONTAINS `bbox` (with a
 *     small tolerance for floating-point/rounding noise). This means a
 *     later enrichment request whose area falls inside a previously
 *     fetched area — the common case when re-analysing tracks from the
 *     same walk, or a second track from the same neighbourhood — is
 *     served entirely from cache, with zero network calls.
 *   - On a miss, `planFetch(bbox)` checks for cached entries that
 *     *partially* overlap the request (without fully containing it) —
 *     e.g. a second walk that covers mostly the same streets but extends
 *     a bit further. Rather than fetching just the new bbox and stacking
 *     a redundant, overlapping entry on top of the old one, the caller
 *     fetches the UNION of the request and every overlapping entry, and
 *     that merged fetch replaces the old entries. Coverage actively
 *     grows and coalesces over repeated enrichments in the same area
 *     instead of accumulating duplicate overlapping blobs. This still
 *     re-fetches the sliver that was already cached (no true delta/
 *     set-difference fetch — that would need rectangle-subtraction
 *     geometry) but converges toward full local coverage of a
 *     neighbourhood, so most future requests become full hits. Note this
 *     is a single-pass merge against the *original* request bbox only —
 *     if the resulting union newly overlaps some other entry that didn't
 *     overlap the original request, that entry isn't folded in too; it's
 *     picked up by a later merge instead.
 *   - If the union of overlapping entries would exceed
 *     MAX_MERGE_AREA_KM2, merging is skipped for that request (fetch
 *     just the requested bbox, leave the old entries as-is) so an
 *     opportunistic merge can never balloon a single Overpass request
 *     past a sane size.
 *   - Entries expire after CACHE_TTL_MS (default 30 days) since OSM data
 *     changes over time and shouldn't be treated as valid forever.
 *   - The cache is capped at MAX_ENTRIES; the least-recently-used entry
 *     is evicted once the cap is exceeded.
 */
const OsmCache = {
  DB_NAME: 'biomap_osm_cache',
  DB_VERSION: 2,
  META_STORE: 'bbox_meta',
  DATA_STORE: 'bbox_data',

  MAX_ENTRIES: 20,
  CACHE_TTL_MS: 30 * 24 * 60 * 60 * 1000, // 30 days

  // A merge-on-overlap union is skipped (falls back to fetching just the
  // requested bbox) if it would exceed this area — mirrors the 12 km²
  // sanity cap ui.js already applies to a single track's own bbox, so an
  // opportunistic merge can never quietly balloon into a much larger
  // Overpass request than the user actually asked for.
  MAX_MERGE_AREA_KM2: 12.0,

  // Bump this if overpass_client.js's buildQuery() tag set ever changes —
  // stale entries fetched under an older query shape won't be reused.
  QUERY_VERSION: 1,

  _dbPromise: null,

  /* ======================================================================
     Pure helpers — no IndexedDB access, directly unit-testable. All of
     these operate on metadata records only (id/bbox/queryVersion/
     fetchedAt/lastAccess) — never the data blobs.
     ====================================================================== */

  /**
   * True if `outer` fully contains `inner`, with `toleranceDeg` slack to
   * absorb tiny floating-point/rounding differences between two requests
   * for essentially the same area.
   */
  _bboxContains(outer, inner, toleranceDeg = 0.0005) {
    return (
      outer.minLat - toleranceDeg <= inner.minLat &&
      outer.maxLat + toleranceDeg >= inner.maxLat &&
      outer.minLon - toleranceDeg <= inner.minLon &&
      outer.maxLon + toleranceDeg >= inner.maxLon
    );
  },

  /** Area of a bbox in square degrees (only used for relative comparison — not m²). */
  _bboxDegArea(bbox) {
    return (bbox.maxLat - bbox.minLat) * (bbox.maxLon - bbox.minLon);
  },

  /** True if `a` and `b` overlap at all (including one containing the other, or touching). */
  _bboxIntersects(a, b) {
    return (typeof GeoUtils !== 'undefined' && typeof GeoUtils.bboxIntersects === 'function')
      ? GeoUtils.bboxIntersects(a, b)
      : (a.minLat <= b.maxLat && a.maxLat >= b.minLat && a.minLon <= b.maxLon && a.maxLon >= b.minLon);
  },

  /** Smallest bbox that contains every bbox in `bboxes`. */
  _unionBBox(bboxes) {
    if (typeof GeoUtils !== 'undefined' && typeof GeoUtils.unionBBox === 'function') {
      return GeoUtils.unionBBox(bboxes);
    }
    if (!bboxes || bboxes.length === 0) return null;
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const b of bboxes) {
      if (!b) continue;
      if (b.minLat < minLat) minLat = b.minLat;
      if (b.maxLat > maxLat) maxLat = b.maxLat;
      if (b.minLon < minLon) minLon = b.minLon;
      if (b.maxLon > maxLon) maxLon = b.maxLon;
    }
    return minLat === Infinity ? null : { minLat, maxLat, minLon, maxLon };
  },

  /**
   * Real-world area of a bbox in km² (accounts for longitude convergence
   * at higher latitudes). Delegates to GeoUtils.bboxAreaKm2.
   */
  _bboxAreaKm2(bbox) {
    if (typeof GeoUtils !== 'undefined' && typeof GeoUtils.bboxAreaKm2 === 'function') {
      return GeoUtils.bboxAreaKm2(bbox);
    }
    if (!bbox) return 0;
    const METERS_PER_DEG_LAT_KM = 111.32;
    const midLat = (bbox.minLat + bbox.maxLat) / 2;
    const h = (bbox.maxLat - bbox.minLat) * METERS_PER_DEG_LAT_KM;
    const w = (bbox.maxLon - bbox.minLon) * METERS_PER_DEG_LAT_KM * Math.cos(midLat * Math.PI / 180);
    return h * w;
  },

  /**
   * Entries that partially overlap `bbox` (and are otherwise valid: right
   * query version, not expired). Does not filter out full-containment
   * matches — in practice callers only reach this after a getForBBox()
   * miss, which already rules those out, but this function makes no
   * assumption about that and is correct either way.
   */
  _findOverlapping(entries, bbox, queryVersion, nowMs) {
    const now = (nowMs != null) ? nowMs : Date.now();
    return entries.filter(e =>
      e && e.bbox &&
      e.queryVersion === queryVersion &&
      (now - e.fetchedAt) <= this.CACHE_TTL_MS &&
      this._bboxIntersects(e.bbox, bbox)
    );
  },

  /**
   * Decide what to fetch on a cache miss for `bbox`. If nothing overlaps,
   * just fetch `bbox` itself. If one or more cached entries overlap,
   * fetch the union of `bbox` and those entries so the result can replace
   * them all as one merged, non-redundant entry — unless that union would
   * exceed MAX_MERGE_AREA_KM2, in which case merging is skipped for this
   * request. Pure — no IndexedDB access.
   *
   * @returns {{fetchBBox: object, mergeIds: Array}} bbox to fetch from
   *   Overpass, and the ids of cached entries it should replace (empty if
   *   no merge is happening).
   */
  _planFetch(entries, bbox, queryVersion, nowMs) {
    const overlapping = this._findOverlapping(entries, bbox, queryVersion, nowMs);
    if (overlapping.length === 0) {
      return { fetchBBox: bbox, mergeIds: [] };
    }
    const unionBox = this._unionBBox([bbox, ...overlapping.map(e => e.bbox)]);
    if (this._bboxAreaKm2(unionBox) > this.MAX_MERGE_AREA_KM2) {
      return { fetchBBox: bbox, mergeIds: [] };
    }
    return { fetchBBox: unionBox, mergeIds: overlapping.map(e => e.id) };
  },

  /**
   * Pick the best cache-hit entry for `bbox` out of a list of stored
   * entries: the smallest (tightest-fitting) entry whose bbox still fully
   * contains the request. Preferring the tightest fit — rather than
   * whichever entry happens to be first — means the cache doesn't
   * degrade to "always match the single broadest entry" once it has
   * accumulated wide coverage over many sessions.
   * Returns the entry object or null. Pure — no IndexedDB access.
   */
  _pickBestMatch(entries, bbox, queryVersion, nowMs) {
    const now = (nowMs != null) ? nowMs : Date.now();
    let best = null, bestArea = Infinity;
    for (const e of entries) {
      if (!e || !e.bbox) continue;
      if (e.queryVersion !== queryVersion) continue;
      if (now - e.fetchedAt > this.CACHE_TTL_MS) continue;
      if (!this._bboxContains(e.bbox, bbox)) continue;
      const area = this._bboxDegArea(e.bbox);
      if (area < bestArea) { bestArea = area; best = e; }
    }
    return best;
  },

  /**
   * Given a list of entries and a cap, return the ones that should be
   * evicted (oldest lastAccess first) to bring the count back to the cap.
   * Pure — no IndexedDB access.
   */
  _selectEvictions(entries, maxEntries) {
    if (entries.length <= maxEntries) return [];
    const sorted = entries.slice().sort((a, b) => a.lastAccess - b.lastAccess);
    return sorted.slice(0, sorted.length - maxEntries);
  },

  /* ======================================================================
     IndexedDB glue
     ====================================================================== */

  _openDb() {
    if (this._dbPromise) return this._dbPromise;
    this._dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB not available in this environment'));
        return;
      }
      const req = indexedDB.open(this.DB_NAME, this.DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        // v1 stored one record per entry with metadata and the (large)
        // data blob mixed together in a single store, which forced every
        // cache-matching decision to deserialise every cached payload
        // just to read a few small fields. Dropping it and starting
        // clean is safe here — this is a cache, not a data store; losing
        // old entries only costs a few extra network fetches later, never
        // real data loss.
        if (db.objectStoreNames.contains('bbox_cache')) {
          db.deleteObjectStore('bbox_cache');
        }
        if (!db.objectStoreNames.contains(this.META_STORE)) {
          db.createObjectStore(this.META_STORE, { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains(this.DATA_STORE)) {
          db.createObjectStore(this.DATA_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // Fire-and-forget: reclaim entries left behind by an older
        // QUERY_VERSION. _pickBestMatch/_findOverlapping already ignore
        // these (both filter on queryVersion === this.QUERY_VERSION), so
        // this is pure hygiene — without it, dead entries just sit in
        // IndexedDB until LRU eviction eventually happens to reach them,
        // wasting quota and slowing every _getAll() metadata scan in the
        // meantime. Never blocks DB open on this — resolve either way.
        this._cleanupStaleVersions(db).catch(() => {}).then(() => resolve(db));
      };
      req.onerror = () => reject(req.error);
    });
    return this._dbPromise;
  },

  /**
   * Delete every cached entry whose queryVersion doesn't match the
   * current QUERY_VERSION. Called once per session, right after the DB
   * is opened (see _openDb).
   */
  async _cleanupStaleVersions(db) {
    try {
      const metaList = await this._getAll(db, this.META_STORE);
      const staleIds = metaList
        .filter(e => e && e.queryVersion !== this.QUERY_VERSION)
        .map(e => e.id);
      if (staleIds.length > 0) {
        await this._deleteEntries(db, staleIds);
      }
    } catch (err) {
      console.warn('OsmCache: stale-version cleanup failed (non-fatal):', err);
    }
  },

  _getAll(db, storeName) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  },

  _get(db, storeName, key) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  _putOne(db, storeName, record) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  /**
   * Write a new entry's metadata and its data blob together in one
   * transaction spanning both stores, so a failure partway through can
   * never leave metadata pointing at a missing blob (or a blob with no
   * metadata referencing it).
   *
   * @param {Array} [deleteIds] - ids of superseded entries to delete in
   *   this SAME transaction. Merged in here (rather than left as a
   *   separate follow-up call) so a sudden page reload/close can never
   *   land between "new merged entry written" and "old overlapping
   *   entries deleted" — the whole put+delete either commits together or
   *   not at all, so the DB never briefly (or permanently, if the reload
   *   happens right then) holds both the new entry and the stale ones it
   *   was meant to replace.
   */
  _putEntry(db, meta, data, deleteIds = []) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction([this.META_STORE, this.DATA_STORE], 'readwrite');
      const metaStore = tx.objectStore(this.META_STORE);
      const dataStore = tx.objectStore(this.DATA_STORE);
      const metaReq = metaStore.put(meta);
      metaReq.onsuccess = () => {
        const id = (meta.id != null) ? meta.id : metaReq.result;
        dataStore.put({ id, data });
      };
      for (const delId of deleteIds) {
        metaStore.delete(delId);
        dataStore.delete(delId);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  /** Delete both the metadata and data records for each id, atomically. */
  _deleteEntries(db, ids) {
    if (ids.length === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([this.META_STORE, this.DATA_STORE], 'readwrite');
      const metaStore = tx.objectStore(this.META_STORE);
      const dataStore = tx.objectStore(this.DATA_STORE);
      for (const id of ids) {
        metaStore.delete(id);
        dataStore.delete(id);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  /* ======================================================================
     Public API
     ====================================================================== */

  /**
   * Look up cached Overpass JSON covering `bbox`. Returns the parsed JSON
   * on a hit, or null on a miss / any failure (callers should always fall
   * back to a network fetch on null — the cache is best-effort and never
   * blocks enrichment from working).
   */
  async getForBBox(bbox) {
    try {
      const db = await this._openDb();
      const metaList = await this._getAll(db, this.META_STORE);
      const match = this._pickBestMatch(metaList, bbox, this.QUERY_VERSION);
      if (!match) return null;

      // Touch lastAccess so this entry looks fresh to the LRU evictor.
      // Metadata-only write — cheap, never touches the data blob.
      // Best-effort — don't block the cache hit on this write succeeding.
      match.lastAccess = Date.now();
      this._putOne(db, this.META_STORE, match).catch(() => {});

      // Only now, having picked exactly one entry, fetch its (possibly
      // large) data blob.
      const dataRecord = await this._get(db, this.DATA_STORE, match.id);
      return dataRecord ? dataRecord.data : null;
    } catch (err) {
      console.warn('OsmCache.getForBBox failed, falling back to network:', err);
      return null;
    }
  },

  /**
   * On a cache miss for `bbox`, decide what to actually fetch from
   * Overpass: just `bbox`, or the union of `bbox` and any partially-
   * overlapping cached entries (see _planFetch). Best-effort — any
   * failure here just falls back to fetching `bbox` alone with no merge,
   * same as if the cache weren't there.
   */
  async planFetch(bbox) {
    try {
      const db = await this._openDb();
      const metaList = await this._getAll(db, this.META_STORE);
      return this._planFetch(metaList, bbox, this.QUERY_VERSION);
    } catch (err) {
      console.warn('OsmCache.planFetch failed, fetching requested bbox only:', err);
      return { fetchBBox: bbox, mergeIds: [] };
    }
  },

  /**
   * Store freshly fetched Overpass JSON under `bbox`. Best-effort — a
   * failure here (e.g. private browsing mode with IndexedDB disabled)
   * only means the next lookup re-fetches from the network; it never
   * breaks enrichment itself.
   *
   * @param {Array} [supersedes] - ids of cached entries this fetch
   *   replaces (from planFetch's mergeIds) — deleted in the SAME
   *   transaction as the new entry is written (see _putEntry), so a
   *   sudden reload/close can never commit the new merged entry while
   *   leaving the old overlapping ones behind (or vice versa).
   */
  async store(bbox, data, supersedes = []) {
    try {
      const db = await this._openDb();
      const meta = {
        bbox,
        queryVersion: this.QUERY_VERSION,
        fetchedAt: Date.now(),
        lastAccess: Date.now()
      };
      await this._putEntry(db, meta, data, supersedes);

      // Eviction only needs metadata — the data blobs never get pulled
      // into memory just to decide who's least-recently-used.
      const metaList = await this._getAll(db, this.META_STORE);
      const toEvict = this._selectEvictions(metaList, this.MAX_ENTRIES);
      if (toEvict.length > 0) {
        await this._deleteEntries(db, toEvict.map(e => e.id));
      }
    } catch (err) {
      console.warn('OsmCache.store failed (cache disabled for this run):', err);
    }
  },

  /** Delete every cached entry. Used by the "Clear Cached Map Data" button. */
  async clear() {
    const db = await this._openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([this.META_STORE, this.DATA_STORE], 'readwrite');
      tx.objectStore(this.META_STORE).clear();
      tx.objectStore(this.DATA_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
};
