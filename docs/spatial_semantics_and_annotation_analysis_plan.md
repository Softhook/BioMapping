# Plan: Spatial Semantics, Named Map Features & Annotation Text Analysis

**Status:** Proposal / Design Specification — 2026-09-14.  
**Companion Documents:** `environmental_enrichment_plan.md` (OSM spatial enrichment & Overpass client), `annotation_tapestry_plan.md` (typographic label rendering & SVG tapestry), `environmental_stress_literature_review.md` (§1.A Nold participatory bio-mapping; §1.B Shoval subjective/objective GIS workflows), `todo.md`.

---

## 1. Conceptual Overview & Scientific Motivation

Current BioMapping environmental enrichment converts the complex urban fabric into abstract, numerical spatial metrics (`osm_dist_green`, `osm_building_density_50m`, `osm_road_class`). While effective for macro-level regression and statistical correlation, this abstraction discards the **specific identity of urban space** — the names of streets, venues, transit stations, parks, and landmarks that define human experience.

Simultaneously, when users record walks or review data, they attach qualitative notes and subjective labels to peaks (`analyzer.setPeakLabel()`). Today, these text annotations remain isolated strings displayed only as plain map tooltips or SVG labels, unanalyzed by the quantitative pipeline.

This plan introduces two complementary capabilities that bridge the gap between **objective physiological signals**, **geospatial semantics**, and **subjective human experience**:

```
           [ 1. Spatial Semantics ]                   [ 2. Physiological Signal ]
           Named OSM Street / Venue                   GSR Phasic Amplitude (µS)
         "Kingsland High St / Junction"             1.8 µS Peak (Arousal = High)
                       \                                   /
                        \                                 /
                         ▼                               ▼
                       [ 3. Qualitative User Annotation ]
                       "Almost stepped in front of bus!"
                       (Valence = Strongly Negative)
                                         │
                                         ▼
                     [ Synthesized Bio-Spatial Knowledge ]
                     High-stress pedestrian-vehicle conflict
                     at a major arterial crossing
```

### The Circumplex Model of Affect (Valence × Arousal)
In psychophysiology, Electrodermal Activity (EDA/GSR) is the gold standard for measuring **autonomic sympathetic arousal** (intensity: calm $\leftrightarrow$ excited/stressed). However, EDA is fundamentally **valence-agnostic**: an acute $+1.5\ \mu\text{S}$ SCR spike can indicate terror (near-miss collision) or delight (bumping into a close friend).

By applying Natural Language Processing (NLP) and sentiment/affective lexicon scoring to user annotations, we extract **Valence** (pleasant $\leftrightarrow$ unpleasant), enabling BioMapping to project events into James Russell's (1980) **Circumplex Model of Affect**:

| Text Sentiment (Valence) | Low GSR (Calm) | High GSR (Aroused) |
| :--- | :--- | :--- |
| **Negative** (*"speeding car"*, *"loud siren"*, *"narrow alley"*, *"dark"*) | Lethargy / Boredom | **Stress / Fear / Anxiety / Conflict** |
| **Positive** (*"beautiful garden"*, *"friendly dog"*, *"fun market"*, *"great music"*) | Serenity / Restfulness | **Joy / Excitement / Vitality** |

---

## 2. Extracting Named Features from OpenStreetMap

### 2.1 Zero New Network Requests
BioMapping’s existing Overpass query in [`visualiser/src/osm/overpass_client.js`](../visualiser/src/osm/overpass_client.js) already downloads the exact OSM elements needed:
* `way["highway"]` — contains street and footpath names (`tags.name`).
* `node/way["amenity"]` — cafes, pubs, restaurants, transit stations, places of worship, schools.
* `node/way["shop"]` — supermarkets, corner shops, bakeries, markets.
* `way/relation["leisure"~"park|garden|nature_reserve"]` — named municipal parks, public squares, commons.
* `way/relation["building"]` — landmark buildings, civic halls, theaters.

Currently, [`osm_enrichment.js`](../visualiser/src/osm/osm_enrichment.js) parses geometric coordinates and class tags but strips away `tags.name` and secondary descriptive tags.

### 2.2 Semantic Spatial Extraction Pipeline
During `OSMEnricher.reconstructGeometries()`, preserve element identity and index them into `SpatialGrid`:

```javascript
// Data schema per named spatial element:
{
  id: element.id,
  type: element.type,        // 'node' | 'way' | 'relation'
  name: tags.name,           // e.g. "Kingsland High Street"
  category: category,        // 'highway' | 'amenity' | 'shop' | 'leisure' | 'building'
  subType: subType,          // e.g. 'pub', 'supermarket', 'park', 'primary'
  geometry: geom             // point coords or polyline/polygon vertices
}
```

### 2.3 Spatial Association Rules
For any coordinate (GPS fix, peak moment, or cluster centroid):
1. **Primary Way / Street Association:**
   - Query candidate `way["highway"]` features within 25 m.
   - Prefer the nearest vehicular carriageway if within 20 m; otherwise the nearest path/footway.
   - Extract `name` (e.g., *"Boleyn Road"*). If unnamed, fallback to road classification (*"residential road"*).
2. **Prominent POI / Landmark Catchment:**
   - Query candidate amenity, shop, leisure, or landmark nodes/polygons within a 35 m buffer.
   - Score by proximity and prominence tier (e.g. Park / Station / Venue > small shop).
   - Form compound spatial descriptor: `"{Street Name} (near {POI Name})"`.

---

## 3. Correlating Named Map Features with GSR

### 3.1 Named Arousal Places (`arousal_places.js`)
Currently, `GSRArousalPlaces.buildPlaces()` clusters multi-track peaks and assigns abstract IDs: `P1`, `P2`, `P3`.
With named feature extraction, places receive automatic semantic identities:
* **Place 1:** *"Junction of Kingsland High St & Dalston Lane (near Dalston Junction Station)"*
* **Place 2:** *"Gillette Square (near The Vortex Jazz Club)"*
* **Place 3:** *"Hackney Downs (North-West Meadow)"*

### 3.2 Corridor & Street-Level Arousal Profiles
Aggregate physiological response along specific named corridors across single or collective walks:
* **Corridor Ranking:**
  $$\text{Mean Arousal}(\text{Street}) = \frac{1}{N} \sum_{i \in \text{Street}} \text{Phasic}(t_i)$$
* **Leaderboard View:**
  1. *Kingsland High Street*: $+1.24\ \mu\text{S}$ avg phasic, $18.2\text{ peaks/km}$ (high sensory/traffic arousal).
  2. *Dalston Lane*: $+0.82\ \mu\text{S}$ avg phasic, $11.4\text{ peaks/km}$.
  3. *De Beauvoir Square*: $+0.14\ \mu\text{S}$ avg phasic, $2.1\text{ peaks/km}$ (restorative baseline).

### 3.3 Urban Typology & Amenity Association
Group named venues into functional urban typologies and compare arousal distributions:
* **Transit Hubs** (train/underground/bus stations) vs.
* **Commercial / High-Street Retail** vs.
* **Pubs & Nightlife Corridors** vs.
* **Civic / Religious Spaces** vs.
* **Parks & Waterways**.

---

## 4. Textual Analysis of User Annotations & Labels

### 4.1 Client-Side Lexicon & Sentiment Engine
To maintain BioMapping's strict client-side, zero-telemetry architecture (no external API keys or server round-trips), implement a lightweight, in-browser NLP processor in `visualiser/src/signal/text_analyzer.js`:

1. **Valence Lexicon (AFINN-165 / VADER Adaptation):**
   - Word tokenization, stemming/lemmatization, and negator handling (*"not loud"*, *"no traffic"*).
   - Assigns a continuous valence score: $V \in [-1.0, +1.0]$.
2. **Urban Stressor & Restoration Taxonomy:**
   Categorize notes into 6 semantic urban trigger domains:
   - **Traffic & Conflict:** *"car"*, *"bus"*, *"lorry"*, *"cyclist"*, *"crossing"*, *"junction"*, *"honk"*, *"swerve"*.
   - **Acoustic & Noise:** *"loud"*, *"siren"*, *"drilling"*, *"construction"*, *"screaming"*, *"quiet"*, *"silent"*.
   - **Social & Crowding:** *"crowded"*, *"packed"*, *"jostled"*, *"busy pavement"*, *"friend"*, *"conversation"*.
   - **Natural & Restorative:** *"tree"*, *"flowers"*, *"birds"*, *"breeze"*, *"sunlight"*, *"green"*, *"peaceful"*.
   - **Spatial & Architectural:** *"narrow"*, *"dark"*, *"open"*, *"alley"*, *"construction"*, *"wide"*, *"view"*.
   - **Physical & Thermal:** *"steep"*, *"stairs"*, *"running"*, *"exhausted"*, *"sweating"*, *"cold"*, *"wind"*.

### 4.2 Word-to-Amplitude Correlation Analysis
Correlate qualitative vocabulary directly with quantitative physiological metrics:
* **Mean Trigger Amplitude:**
  $$\bar{A}(w) = \frac{1}{|K_w|} \sum_{k \in K_w} \text{PeakAmplitude}_k$$
* **Empirical Ranking Example:**
  * *"near miss"* $\to$ **$+2.45\ \mu\text{S}$** (mean rise time: $1.8\text{s}$) — Extreme acute threat.
  * *"siren"* $\to$ **$+1.62\ \mu\text{S}$** (mean rise time: $2.1\text{s}$) — Acoustic startle.
  * *"crowded"* $\to$ **$+0.78\ \mu\text{S}$** (mean rise time: $4.2\text{s}$) — Sustained environmental friction.
  * *"garden"* $\to$ **$+0.15\ \mu\text{S}$** (mean rise time: $4.8\text{s}$) — Low arousal, positive appraisal.

### 4.3 Semantic Word Clouds & Typographic Tapestry Integration
Feed analyzed annotations directly into the SVG Map Exporter and [`annotation_tapestry_plan.md`](annotation_tapestry_plan.md):
* **Color-Coded by Affective State:**
  - Red / Orange: High Arousal + Negative Valence (Stress, Danger, Frustration).
  - Yellow / Gold: High Arousal + Positive Valence (Excitement, Social Interaction, Discovery).
  - Blue / Teal: Low Arousal + Positive Valence (Restoration, Calm, Scenic Beauty).
  - Slate / Grey: Neutral descriptive labels.
* **Typographic Scaling:** Sized by physiological peak prominence ($P2$ principle from the Tapestry Plan: importance sets visual size).

---

## 5. Implementation Roadmap

### Phase 1: Overpass Name Preservation & Spatial Tagging
- [ ] Update `OSMEnricher.reconstructGeometries()` in `osm_enrichment.js` to preserve `name`, `amenity`, `shop`, `leisure`, and `highway` tags.
- [ ] Extend `_evaluatePosition()` to resolve `s.osm_name` (street name) and `s.osm_poi` (closest named amenity/landmark).
- [ ] Append `osm_name` and `osm_poi` columns to exported CSVs and mirror in `csv_parser.js`.

### Phase 2: Named Arousal Places
- [ ] Update `GSRArousalPlaces.buildPlaces()` in `arousal_places.js` to assign automatic human-readable place titles derived from constituent peak spatial matches.
- [ ] Surface named place titles in `map_manager_arousal_places.js` and Leaflet place popups.

### Phase 3: Text Analysis Engine (`text_analyzer.js`)
- [ ] Implement zero-dependency client-side tokenizer and AFINN/VADER-derived lexicon scorer.
- [ ] Add taxonomy rule-classifier for urban stress/restoration categories.
- [ ] Compute Circumplex quadrant (Valence $\times$ Arousal) for all labeled peaks.

### Phase 4: UI Dashboard & Tapestry Visualization
- [ ] Add an "Annotations & Semantics" tab to the Environmental Analysis panel showing:
  - Affective Circumplex scatter plot (Valence vs. Phasic Peak Amplitude).
  - Word impact ranking table (word vs. mean SCR amplitude).
  - Street/Corridor leaderboard.
- [ ] Connect sentiment colors and semantic classifications to `label_placement.js` and `map_exporter.js` SVG tapestry layers.

---

## 6. Verification & Testing Plan

* **Unit Tests (`test_spatial_semantics.js`):**
  - Verify point-to-way street name resolution with synthetic Overpass fixtures.
  - Verify POI buffer catchment and compound name generation (`"{Street} near {POI}"`).
  - Verify graceful fallback for unnamed footways or missing tags.
* **NLP & Sentiment Tests (`test_text_analyzer.js`):**
  - Benchmark valence scoring on synthetic urban annotation datasets against known AFINN reference scores.
  - Verify negator handling (*"not stressful"*, *"no noise"*).
  - Verify taxonomy categorization across all 6 urban domains.
* **Regression & Integration Tests:**
  - Verify that adding named columns preserves 100% backward compatibility with existing tracks and CSV imports.
  - Ensure `npm test` runs with 0 failures across the test suite.
