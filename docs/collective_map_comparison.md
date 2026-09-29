# Comparing people on the Collective map: options and evidence

*September 2026. Research only: nothing in the app has been changed.*

## In short

- **The current z-score adjustment works, and it's needed.** Without it the group map mostly shows *who* walked where, not *what places* did to people.
- **The quick-reaction map (phasic) shows real places.** Two independent groups of walkers light up the same places far more often than chance.
- **The slow background-level map (tonic) mostly shows time, not place.** Readings creep up during most walks, so this map lights up wherever people were near the end.
- **The way readings are combined on the map has two flaws.** Busy routes look more aroused just because more people passed. People who stood still count for more than people who walked past.
- **Better methods exist and were tested on the real walks.** The biggest win is simple: give each walker one vote per spot. More advanced options (significance testing and a combined time + place model) help further in specific cases.

## 1. The problem in plain terms

Everyone's skin conducts electricity differently. One person's calm reading can be higher than another person's excited reading. So raw readings can't be compared between people.

The app's fix is to measure each person against their own normal. Each walk's readings are turned into "how far above or below this person's usual level" (a **z-score**). This is the standard approach in skin-conductance research. It's generally preferred over alternatives such as dividing by each person's biggest response (Braithwaite & Watson 2015; Ben-Shakhar 1985; Bush et al. 1993).

That fixes the difference *between people*. It leaves four other problems:

1. **Drift over time.** Skin conductance tends to rise during a walk as the skin gets sweatier and the electrodes settle. A person's own "normal" isn't steady.
2. **Uneven foot traffic.** Some streets were walked by 20 people, others by 2.
3. **Uneven time spent.** Someone who stops for five minutes leaves hundreds of readings in one spot.
4. **Chance.** With enough spots, some will look "hot" by luck.

## 2. How the options were tested

Opinions about statistics are cheap, so each option was run on the **36 walks recorded in London**. The other areas have too few walks to test. Three checks were used:

| Check | What it asks | Why it matters |
|---|---|---|
| **Two groups agree** | Split the walkers randomly into two halves, make a map from each, and compare. Repeated 16–20 times. | If places really affect people, two separate groups should find the same hot and cold spots. |
| **Predicts a new walker** | Build the map from everyone except one person, then see how well it predicts that person's own readings. Repeated for every walker. | This is what a map is *for*: telling you what a new visitor is likely to feel. |
| **Busy-route bias** | Scramble the data (below), then see whether the map still lights up where more people walked. | Any pattern left after scrambling comes from the method, not from the places. |

**Scrambling.** Each walker's readings are slid along their own route, so the readings no longer line up with the right places. Everything else stays the same: the same routes, the same amount of data, the same ups and downs over time. Whatever a method shows on scrambled data is what it shows **by chance alone**. A good method scores well on real data and near zero on scrambled data.

Scores are correlations. **1** means perfect agreement, **0** means none, and negative means opposite. What matters is the **gap between real and scrambled**.

## 3. What's in the app today

The map currently:
- averages every reading near a spot (so a person counts in proportion to how long they stayed there), and
- blends that average 50/50 with **the single highest reading anyone had nearby** (the "Peak Preservation" slider, default 0.5).

| Map | Two groups agree (real / chance) | Predicts new walker (real / chance) | Busy-route bias |
|---|---|---|---|
| Quick reactions (phasic) | 0.53 / **0.36** | 0.23 / 0.09 | **0.38** |
| Arousal Index | 0.46 / 0.25 | 0.16 / 0.06 | 0.34 |
| Background level (tonic) | 0.34 / 0.25 | −0.02 / −0.06 | 0.42 |

**Chance agreement is high: 0.36 for phasic.** The "highest reading nearby" part of the blend finds a high reading somewhere on any busy route, even in scrambled data. So two groups "agree" partly just because they walked the same streets.

*These numbers come from a simplified copy of the map calculation (25 m grid, no latency offset). They are close to, but not exactly, what the app draws. Earlier checks on the app's own code gave the same picture.*

## 4. Options, grouped by problem

### Problem A: combining readings from many people at one spot

| Option | What it does | Two groups agree (real / chance) | Predicts new walker (real / chance) | Busy-route bias |
|---|---|---|---|---|
| Today: average + highest reading | See above | 0.53 / 0.36 | 0.23 / 0.09 | 0.38 |
| Plain average of all readings | Drop the "highest reading" part | 0.49 / 0.05 | 0.21 / −0.06 | 0.00 |
| **One vote per walker** | Average each person's readings at the spot first, then average across people | 0.53 / 0.09 | 0.27 / −0.07 | −0.05 |
| **One vote per walker + pull towards "normal"** | As above, but a spot visited by few people is pulled towards 0 ("typical"). A spot needs several people agreeing before it looks hot. | **0.55 / 0.07** | **0.28 / −0.12** | −0.09 |
| Consistency score | Average across people ÷ how much they disagree. "Did people agree this place is hot?" | 0.50 / 0.05 | 0.26 / −0.07 | −0.09 |

*(Quick-reaction / phasic data. The Arousal Index shows the same ranking: "one vote + pull towards normal" scores 0.43 / 0.06 and 0.21 / 0.02.)*

**Finding:** the best option tested combines two ideas.

1. **One vote per walker.** Say Alice waited calmly outside a station for 5 minutes (about 300 readings), while Bob and Cara walked past aroused (about 10 readings each). Today the map averages all 320 readings, so Alice swamps the others and the spot looks calm. With one vote each, we first take each person's own average there, then average the three people. The spot now looks fairly aroused, because 2 of the 3 people reacted.
2. **Few-visitor spots pulled towards normal.** "Normal" here is 0: each person's usual level. When averaging, pretend 3 extra "perfectly normal" people also visited. One startled person at +2 gives 2 ÷ (1 + 3) = 0.5, only mildly hot. Ten people all at +2 give 20 ÷ (10 + 3) = 1.5, clearly hot. A spot only looks strongly hot when several people agree.

Together these keep the real pattern: two separate groups of walkers still pick out the same places (0.55, versus 0.53 today). They also stop busy streets looking hot just because more people walked there.

The "pull towards normal" idea is borrowed from disease mapping. Areas with small populations there have the same problem: a few cases can make a tiny village look like an epidemic. The standard fix is called **empirical Bayes shrinkage** (Clayton & Kaldor 1987).

The **Peak Preservation** slider was added so a single strong reaction isn't averaged away. That's a real concern. But the tests show the "highest reading nearby" trick mostly adds chance hot spots. A single strong reaction is better shown as a marked event than blended into the group surface.

### Problem B: people's readings have different shapes

The z-score uses the average and spread of each walk. Two alternatives were tried:

| Option | Result |
|---|---|
| **Robust z-score** (uses the middle value and typical deviation, so it's less affected by extremes) | **Worse.** Quick-reaction readings sit near zero most of the time, so the "typical deviation" is tiny. Every reaction then becomes a huge number, and the map fills with chance hot spots (chance agreement 0.83). |
| **Rank** (each reading becomes its position from lowest to highest within the walk) | About the same as the z-score, never better. |

**Finding:** keep the ordinary z-score. It's also what the skin-conductance literature recommends (Braithwaite & Watson 2015).

### Problem C: the background level (tonic) drifts upwards

In 33 of 54 walks, the tonic z-value climbs steadily with time. The typical correlation with time elapsed is 0.75. Several fixes were tried:

| Option | What it does | Two groups agree (real / chance) | Predicts new walker (real / chance) |
|---|---|---|---|
| Today (z-score only) | — | ≈ chance | ≈ chance |
| Remove a straight-line trend | Subtract each walk's straight-line rise over time, then z-score | 0.14 / −0.04 | 0.13 / 0.00 |
| Compare with the last 5 minutes | Each reading relative to that person's recent level | ≈ chance | 0.07 / −0.04 |
| **Combined time + place model** | Estimates each walker's own curve over time *and* one shared effect per place, at the same time, so neither is blamed for the other | **0.17–0.20 / ≈0** (three separate runs) | not tested |

*The combined model was scored on a coarser, unsmoothed grid, so its numbers aren't directly comparable with the rows above. Only the real-vs-chance gap is meaningful.*

**Finding:** the background-level map carries **very little place information** with any method. The combined model is the only one that clearly beats chance, and only weakly.

The combined model is a simple version of a **generalised additive model (GAM)**: a flexible model that adds together a smooth curve for time, a smooth surface for place and a per-person adjustment. Environmental-stress studies with wearables use this kind of mixed model (for example Zhang et al. 2023). It's what statisticians would reach for with a full version of this problem (see section 5).

**Don't use the combined model for quick reactions.** Tested on phasic data, it removed about half of the real place signal. Those readings don't drift, so the time curve just soaks up real effects.

### Problem D: which hot spots are real?

The map places its contour lines by rank within itself (top 10%, top 20%, and so on). **It always shows hot spots, even for pure noise.**

**Option: a significance test for each spot.** Scramble the data 199 times. For each spot, see how often scrambled data produces a value as extreme as the real one. Then apply a standard correction for testing hundreds of spots at once, so that no more than about 1 in 10 of the flagged spots is expected to be a false alarm (the **false discovery rate** method of Benjamini & Hochberg).

Results on London spots visited by at least 3 people:

| Data | Spots tested | Pass the test |
|---|---|---|
| Quick reactions (phasic), real | 462 | **57** (23 hot, 34 cold) |
| Quick reactions, scrambled (should be 0) | 462 | **0** ✓ |
| Arousal Index, real | 462 | 0–71, depending on the run: borderline |
| Background level (tonic), real | 462 | **0** |

The test behaves correctly: it finds nothing in scrambled data. On real data it confirms about **1 in 8** of the well-visited phasic spots.

**Watch out:** the scrambling has to allow *any* slide along the route. A first version only slid readings 20–80% of the way along. It flagged 22% of scrambled spots as "significant" when about 5% was expected, because the start and end of a walk often differ. Other researchers have reported the same trap with this kind of scrambling (see the bioRxiv "cyclic shift" preprint in the sources).

A related, widely used method is **Getis-Ord Gi\*** hot-spot analysis. It asks whether a spot *and its neighbours* are higher than the overall average. Urban stress studies with wearables use it (Kyriakou & Resch 2019 and follow-ups). It's simpler than the scrambling test but assumes readings are independent, which walk data are not.

### Problem E: peaks (counted reactions)

Mapping where individual peaks happened mostly reproduces **where people walked**: the map correlates 0.98 with a scrambled version. With one vote per walker it improves, but it stays weak. If peaks are mapped, they should be shown as **peaks per minute spent at the spot** (a rate) rather than a count. Otherwise busy streets always win.

## 5. More advanced approaches (not tested here)

These are the "proper" statistical versions of what's above. They need more work, and some would need R or Python outside the browser.

| Approach | What it adds | Cost |
|---|---|---|
| **Full GAM / mixed model** (e.g. R `mgcv`: `s(lat, lon) + s(time, by = walker) + s(walker, bs = "re")`) | Separates place, time and person properly. Gives an uncertainty band for every spot. Handles readings that follow each other closely. | Needs R/Python. An offline analysis, not live in the app. |
| **Gaussian-process / kriging surface** | A smooth map with a built-in "how sure are we here" layer, instead of a separate checkerboard | Heavy to compute for large grids. Needs choices about how quickly place effects change over distance. |
| **Bayesian hierarchical spatial model** (e.g. BYM / INLA, as used in disease mapping) | Principled version of "pull towards normal" plus "neighbouring spots are similar" | Specialist tooling |
| **Street-segment map instead of a grid** | Aggregate per street section (the app already matches walks to OpenStreetMap streets) rather than per grid square | Changes the look of the map. Removes blur across buildings between parallel streets. |
| **Geographically weighted regression** | Asks *which features* (traffic, crowds, green space) drive arousal, and whether that differs across the city (Zhang et al. 2023) | Needs the environment data per spot, which the app already collects |
| **Per-person response model** | Estimates each person's own sensitivity to places, rather than assuming everyone reacts equally strongly | Needs more walks per person |

## 6. Suggested plan

In order of value for effort:

1. **One vote per walker, with few-visitor spots pulled towards normal.** This was the clear winner in testing. It's a contained change to how the map combines readings.
2. **Set Peak Preservation to 0 by default,** or remove it once step 1 is in place. It mostly adds chance hot spots.
3. **Add an optional "only show spots that pass the significance test" layer** for the quick-reaction map. It can replace or complement the current coverage checkerboard.
4. **Background level (tonic): add a warning,** or use the combined time + place model. With the current data, don't present the tonic map as a map of places.
5. **Peaks: show as a rate per minute spent,** not a count.
6. **Offline:** a full GAM in R on the exported CSVs, as a gold-standard check on what the app shows.

Each step should be A/B tested on the real walks with the checks in section 2 before it replaces the current method.

## 7. Limits of this research

- Only the London walks (36) could be tested. Other areas have 1–9 walks, which is too few.
- Even the best map is a **weak predictor for any one person**: a correlation of about 0.28, which explains roughly 8% of one person's variation. Group maps describe tendencies, not what each individual will feel.
- The tests used a simplified copy of the map calculation without the latency offset. Numbers will shift a little inside the app. The ranking of methods should not.
- Walks in London tend to follow similar routes. Where everyone walks the same way in the same direction, *no* method can fully separate "late in the walk" from "this place".
- Biosensing shows *that* something happened, not *why*. Pairing it with interviews or notes is still needed to interpret hot spots (Osborne & Jones 2017).

## Sources

- Braithwaite, J.J. & Watson, D.G. (2015). *Issues surrounding the normalization and standardisation of skin conductance responses (SCRs).* University of Birmingham technical note. [PDF](https://www.birmingham.ac.uk/Documents/college-les/psych/saal/research-note-SCRs.pdf). Summarises Ben-Shakhar (1985, 1987) and Bush et al. (1993) on why z-scores are preferred.
- Kyriakou, K. & Resch, B. (2019). *Detecting moments of stress from measurements of wearable physiological sensors.* Sensors 19(17). [Link](https://mdpi.com/1424-8220/19/17/3805/htm)
- Kyriakou, K. et al. *Spatial analysis of moments of stress derived from wearable sensor data* (Getis-Ord Gi\* hot spots). [ResearchGate](https://www.researchgate.net/publication/337071090_Spatial_Analysis_of_Moments_of_Stress_Derived_from_Wearable_Sensor_Data)
- Zhang et al. (2023). *Assessing the association between overcrowding and human physiological stress response.* Int. J. Health Geographics (mixed models + geographically weighted regression). [Link](https://pmc.ncbi.nlm.nih.gov/articles/PMC10286433/)
- *Identifying environmental stress factors in urban cycling* (Gi\* on stress-point ratios). [Link](https://link.springer.com/article/10.1007/s44212-025-00096-6)
- *Decoding pedestrian stress on urban streets using electrodermal activity* (collective sensing across participants). [Link](https://www.sciencedirect.com/science/article/pii/S0968090X2400473X)
- *Mapping of electrodermal activity during outdoor community-level mobility tasks* (EDA + GPS). [Link](https://pubmed.ncbi.nlm.nih.gov/34123405/)
- Osborne, T. & Jones, P. (2017). *Biosensing and geography: a mixed methods approach.* Applied Geography 87.
- Clayton, D. & Kaldor, J. (1987). *Empirical Bayes estimates of age-standardized relative risks for use in disease mapping.* Biometrics. Overview: [Spatial epidemiology workshop](https://bookdown.org/epeterson_2010/spatial_epidemiology_workshop/Module_3.html)
- mgcv (R) documentation on additive mixed models: [gamm](https://rdrr.io/cran/mgcv/man/gamm.html)
- *Null models for community dynamics: beware of the cyclic shift algorithm* (bioRxiv) — the trap described in Problem D. [Link](https://www.biorxiv.org/content/10.1101/762278.full.pdf)
- ESRI: [How Hot Spot Analysis (Getis-Ord Gi\*) works](https://pro.arcgis.com/en/pro-app/3.3/tool-reference/spatial-statistics/h-how-hot-spot-analysis-getis-ord-gi-spatial-stati.htm)
