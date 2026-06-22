# China's Clean Tech Exports — a scrollytelling flow map

**Live demo:** https://chris-tine-wei.github.io/china-clean-tech-exports/

An animated, dark "trade winds" flow map of China's clean-technology exports,
built on [Ember's China Cleantech Export Data](https://ember-energy.org/data/china-cleantech-export-data/)
(CC-BY-4.0). Glowing teal arcs run from China to each destination country, sized
by solar-PV export value; a Scrollama narrative walks through the 2026 story.

## The story (4 steps)

1. **China's dominance** — one country supplies almost every panel on the map.
2. **The Africa surge** — March 2026: exports to Africa hit **$685M** in a month
   (≈3× February), led by **Nigeria, Kenya and Ethiopia** (~0.7–1 GW each).
3. **The Gulf slowdown** — Middle East solar imports fall from a **$286M** peak
   (Sep 2025) to **$93M** (Apr 2026), tracking the Strait of Hormuz shutdown.
4. **The bigger shift** — solar keeps growing, but China now exports **2–4× more
   batteries and EVs by dollar value** than solar PV.

## Run it locally

```bash
# 1. Add your Mapbox token
#    Open app.js and replace PASTE_YOUR_MAPBOX_TOKEN_HERE with your public token
#    (starts with pk.). Free at https://account.mapbox.com/access-tokens/

# 2. Serve the folder (fetch() of the JSON needs http://, not file://)
python -m http.server 8000

# 3. Open http://localhost:8000
```

## Regenerate the data (optional)

`data/flows.json` ships ready to use. To rebuild it from the full raw dataset
(monthly back to 2023, every destination), download the raw CSV once and run the
reshape script:

1. From the [Ember page](https://ember-energy.org/data/china-cleantech-export-data/),
   download **"China Cleantech Data – by technology category (CSV)"** and save it as
   `data/clean_tech_exports_full_release_monthly.csv`.
2. Run:

   ```bash
   pip install pandas
   python scripts/2026-06-17-reshape-exports.py
   ```

   This writes:
   - `data/2026-06-17-reshaped-solar-by-destination.csv` — tidy long table
     (`area, region, date, category, usd_value, solar_gw_est`)
   - `data/flows.json` — the compact payload the map reads
   - `data/flows-monthly.json` — per-country monthly values that drive the timeline scrubber

## Files

```
index.html                              page + narrative steps
style.css                               dark "trade winds" theme
app.js                                  Mapbox GL + Turf arcs + Scrollama
data/flows.json                         data the map reads
data/country-centroids.json             static [lon,lat] lookup (no live geocoding)
scripts/2026-06-17-reshape-exports.py   pandas: raw CSV -> tidy table + flows.json
```

## Deploy to GitHub Pages

The app is fully static. Push this folder to a repo and enable Pages
(Settings → Pages → deploy from branch, root). No build step required.

## Notes on the numbers

Ember's raw download reports export **value in US$**. GW figures shown are
**estimates** using a single stated assumption (~$0.10/W, 2025 Chinese module
export prices); the UI leads with dollar values, which are exact.

Data © Ember, released under CC-BY-4.0.
