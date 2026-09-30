# Whole-app check

Opens the app in real Google Chrome with real walks and goes through it the
way a person would. Each step prints PASS or FAIL; any page error fails the
step it happened in.

```
npm run smoke                        # check this copy
npm run smoke -- --compare=main      # also run the same steps on main
```

Nothing here runs in `npm test`: it takes a couple of minutes and needs
Chrome and the walks in `tracks/` (not stored in git). Run it before merging
bigger changes.

## Steps

1. Open a project (`tracks/Stokey.zip` by default) and wait for all its walks.
2. Single view: the stats bar is filled in.
3. Collective view: each of the 8 map types draws, with a colour key that
   shows numbers (no `NaN`).
4. Environmental dashboard: each tab opens; the correlation and road tables
   have rows.
5. Track list: add a walk (`tracks/biomap_001.csv`), rename it, delete it.
6. 3D globe and back to the 2D map.
7. Live tab and back.

## Options

- `--project=<file>` / `--walk=<file>`: other files from `tracks/`.
- `--compare=REF`: also run on git `REF` (a throwaway checkout). A failing
  step is then marked as an older problem (fails on `REF` too) or NEW.
- `--root=<visualiser folder>`: check another copy instead of this one.
- `--headful`: show the browser window.

Map tiles are answered with a blank image and every other outside request
with nothing (see `../zoom_perf/browser.js`), so the Junction Turns tab has
no OSM roads to work with; the check only makes sure it opens cleanly.

Exits 1 if any step fails on the copy being checked, 2 if it can't run.
