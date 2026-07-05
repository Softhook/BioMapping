# Literature Analysis: Physiological Stress and the Urban Environment

This document synthesises environmental psychology and mobile biosensing literature to identify which environmental features are most strongly associated with galvanic skin response (GSR/EDA) fluctuations, how to extract them from OpenStreetMap (OSM), and how to incorporate external tree canopy and vegetation databases.

---

## 1. Literature-Backed Environmental Stressors & Restorative Features

Mobile biosensing studies (using GSR + GPS) show that the autonomic nervous system reacts to specific environmental triggers. We classify these into **stressors** (which increase skin conductance level and peak frequency) and **restorative buffers** (which accelerate recovery and lower tonic baseline).

### A. Major Stressors
1. **Traffic and Acoustic Stress (Noise & Danger)**
   - *Finding*: Road traffic noise and proximity to moving vehicles are the strongest drivers of tonic skin conductance spikes. Busy intersections and multi-lane roads trigger significant phasic SCR peaks.
   - *OSM Proxy*: `highway` classification, proximity to motorways/primary roads, and intersection density.
2. **Built Complexity and Enclosure (Urban Canyons)**
   - *Finding*: High-density building environments with narrow street corridors (low Sky View Factor) create a sense of crowding and visual monotony, elevating baseline SCL.
   - *OSM Proxy*: Building footprint area density and building counts.
3. **Social/Pedestrian Activity and Crowding**
   - *Finding*: Dense commercial areas, public transport hubs, and crowds increase physiological arousal. (Note: This arousal is not always negative stress; it represents active cognitive processing and sensory stimulation).
   - *OSM Proxy*: Shops (`shop=*`), transit hubs (`highway=bus_stop`, `railway=station`), and food/beverage amenities (`amenity=cafe/restaurant`).

### B. Restorative Buffers
1. **Visual Greenness (The Green Space Effect)**
   - *Finding*: Immersion in green spaces triggers rapid sympathetic withdrawal (lowering GSR/SCL) and buffers noise annoyance. High canopy and natural ground cover are more restorative than paved plazas.
   - *OSM Proxy*: Park polygons (`leisure=park`, `landuse=grass`), forests (`landuse=forest`, `natural=wood`), and trees (`natural=tree`).
2. **"Blue" Restoration (Water Bodies)**
   - *Finding*: Proximity to water (rivers, lakes, coastlines) has been shown in several studies to have an equal or stronger restorative effect than green spaces.
   - *OSM Proxy*: Proximity to waterways (`waterway=*`) and natural water bodies (`natural=water`).

---

## 2. Mapping Literature Features to OpenStreetMap Tags

| Literature Concept | Target Variable | OSM Tags / Query Logic | Metric Computation |
| :--- | :--- | :--- | :--- |
| **Traffic Noise & Danger** | Distance to Major Road | `way["highway"~"motorway|trunk|primary|secondary"]` | Shortest orthogonal distance (m) to nearest matching segment. |
| | Road Category Stress | `way["highway"]` | Category of nearest segment (e.g. `residential`, `pedestrian`, `primary`). |
| **Green Space Restoration** | In Park Indicator | `way/relation["leisure"="park"]`, `way/relation["landuse"="grass"|"forest"|"meadow"]`, `way/relation["natural"="wood"]` | Binary (1 = inside polygon, 0 = outside) using ray-casting. |
| | Green Space Density | Same as above | Concentric grid sampling (25 points in 50m radius) testing polygon containment. |
| **Water Restorative Buffer** | Distance to Water | `way/relation["natural"="water"]`, `way["waterway"]` | Shortest distance (m) to nearest water boundary or river line. |
| **Built Enclosure** | Building Density | `way/relation["building"]` | Sum of building areas or count of centroid distances within 50m. |
| **Social Activity Arousal** | Amenity Count | `node/way["amenity"~"cafe|restaurant|pub|fast_food|bank|post_office"]`, `node/way["shop"]` | Count of point/polygon entities within 50m. |
| | Transport Node Proximity | `node["highway"="bus_stop"]`, `node["railway"="station"]` | Count of transport nodes within 50m. |
| **Micro-greenery** | Tree Density | `node["natural"="tree"]`, `way["natural"="tree_row"]` | Count of individual tree elements within 50m. |

---

## 3. Alternative Tree Canopy & Vegetation Databases

OpenStreetMap is excellent for structural features (roads, buildings, parks), but **OSM tree data is highly inconsistent** (often manually mapped by hobbyists and sparse outside major European cities). To achieve higher-quality vegetation data, several external databases are valuable:

```mermaid
graph TD
    A[GSR + GPS Data] --> B[OSM Data (Roads, Buildings, Parks)]
    A --> C[External Vegetation Databases]
    C --> D[NDVI Satellite Imagery]
    C --> E[LiDAR Canopy Databases]
    C --> F[Street View Greenery Index]
    B & D & E & F --> G[Enriched Machine Learning Dataset]
```

### A. NDVI (Normalized Difference Vegetation Index)
* **What it is**: Satellite-derived index (from Sentinel-2 or Landsat, 10m to 30m resolution) indicating chlorophyll activity and live green vegetation.
* **Why it's useful**: It provides a continuous, objective measure of vegetation across the entire globe. Unlike OSM, it captures private gardens, street hedges, weeds, and grass verges that are rarely mapped in vector databases.
* **GSR Correlation**: Highly correlated with lower baseline skin conductance.
* **How to integrate**: 
  - *Offline Pre-processing*: Before importing to the app, run a Python script (using `rasterio` and Google Earth Engine) to extract NDVI values along the track's coordinates.
  - *App API Integration*: Integrate a lightweight proxy API that queries Sentinel Hub or Google Earth Engine for a coordinate and returns the historical NDVI value for that season.

### B. LiDAR Tree Canopy Maps (1m High-Resolution)
* **What they are**: Laser-scanned 3D datasets generated by local governments, providing exact tree heights and canopy crowns.
* **Why they's useful**: They show the exact shape and volume of trees shading the street. Overhead shade has a physical cooling and shading effect which reduces thermal-induced GSR spikes.
* **GSR Correlation**: Strongly correlated with reduced physiological stress in hot seasons due to thermal comfort.
* **How to integrate**: Typically distributed as localized GeoTIFFs or WMS services. Users must download the municipal raster file and query it locally.

### C. Green View Index (GVI / Google Street View)
* **What it is**: Computer vision analysis of street-level 360-degree images to calculate the percentage of green pixels (foliage) visible from a human's point of view.
* **Why it's useful**: **This is the single most predictive metric for physiological stress reduction.** Humans do not see the environment from a satellite perspective (bird's-eye view); they experience it from eye-level. A tall, leafy tree canopy creates a high GVI, even if the satellite footprint is small.
* **GSR Correlation**: Strongest direct negative correlation with GSR peaks.
* **How to integrate**: Query the Google Street View API or Mapillary API for street-level images along the track coordinates and use a pre-trained segmentation model (or pre-computed GVI APIs) to assign GVI values.

---

## 4. Integration Recommendation for the Visualizer

To keep the application responsive and completely self-contained in the browser, we recommend a phased integration strategy:

1. **Phase 1 (Core OSM - Browser-Native)**:
   - Implement the spatial engine using OpenStreetMap Overpass queries. This provides immediate, free, and zero-configuration attributes (roads, parks, buildings, amenities) without API keys.
2. **Phase 2 (Continuous Greenness - NDVI Integration)**:
   - Add support for importing an **NDVI CSV Column**. If the user runs a Python pre-processing script (which we can provide in the `scratch/` folder or codebase), it adds satellite NDVI values to the CSV. The visualizer will read and overlay this column alongside OSM.
3. **Phase 3 (Google Street View / Mapillary GVI)**:
   - Add an optional API Key field in settings for Mapillary (open-source) or Google Street View, enabling the app to fetch street-level greenery metadata dynamically where street-level photos are available.

---

## 5. Key Academic Studies & Pioneering Precedents

To contextualise this work within urban psychology, spatial analysis, and mobile computing, refer to these key academic precedents:

### A. The Foundational Work: Participatory Bio Mapping
*   **Nold, C. (2009). *Emotional Cartography: Technologies of the Self*.**
    *   *Significance*: Christian Nold is the visual artist and researcher who pioneered combining Galvanic Skin Response (GSR) sensors with GPS logging in 2004, coining the term **"Bio Mapping"**. This book compiles essays, maps, and studies showing how individuals and community groups map their physiological arousal to articulate local environmental, social, and political spatial issues.
*   **Willis, K. S., & Nold, C. (2022). *"Sense and the city: An Emotion Data Framework for smart city governance."***
    *   *Significance*: Explores how spatial emotion data (combining EDA and coordinate tracks) can be structured for civic planning, moving away from purely commercial biometric uses.

### B. Modern GIS-Wearable Studies (Greenery & Built Environment)
*   **Voss, H., et al. (2024). *"Quantifying the Impact of Urban Green Spaces on Mental Well-Being Using Wearable Sensors and GIS."***
    *   *Significance*: Correlates spatial vegetated metrics (NDVI, urban tree canopy) with real-time galvanic skin response (SCL baseline reduction). It confirms that exposure to visual greenery triggers rapid sympathetic withdrawal (calming effects).
*   **Zhang, Z., et al. (2022). *"Assessing the association between urban features and human physiological stress response using wearable sensors in different urban contexts."***
    *   *Significance*: Uses wearable EDA monitors on participants walking specific urban tracks. Relates stress peak frequency to building density, street corridors, and open public spaces.

### C. Traffic, Cyclist, and Pedestrian Stress Mapping
*   **Moser, M. K., et al. (2025). *"Understanding the influence of urban characteristics on cyclists' stress measured through wearable sensors."***
    *   *Significance*: Tracks active cyclists with wearable sensors (including EDA), mapping stress spikes to road geometry, traffic lanes, intersections, and street vegetation. Proves a strong correlation between lack of cycling infrastructure and physiological arousal peaks.
*   **Zeile, P., et al. (2016). *"Urban Emotions — GIS-Based Urban Planning and Socio-Spatial Research with Biosensors."***
    *   *Significance*: Discusses the "Urban Emotions" methodology, integrating EDA sensors, GPS tracking, and spatial databases to assist urban planners in identifying pedestrian stress hot-spots (e.g. narrow crossings, heavy traffic noise) to improve walkability.
*   **Shoval, N., et al. (2018). *"Mapping tourist experiences in space and time using GPS and physiological sensors."***
    *   *Significance*: A pioneering early study that mapped tourists' real-time physiological arousal (EDA) to historical sites, crowded streets, and traffic crossings in old city centers, establishing empirical methods for spatial emotion analytics.
