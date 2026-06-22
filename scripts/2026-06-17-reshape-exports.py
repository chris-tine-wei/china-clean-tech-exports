#!/usr/bin/env python3
"""
Reshape Ember's China Cleantech Export data into the tidy tables the
scrollytelling map consumes.

INPUT  (download once from Ember; CC-BY-4.0):
    data/clean_tech_exports_full_release_monthly.csv
    https://ember-energy.org/data/china-cleantech-export-data/

OUTPUTS:
    data/2026-06-17-reshaped-solar-by-destination.csv  tidy long table
    data/flows.json                                    compact payload for the web app

The raw file carries export VALUE in USD only (Ember derives GW separately in
their explorer). We add an *estimated* solar capacity column using a single,
clearly-stated module price assumption so it can be labelled honestly in the UI.

Usage:  python scripts/2026-06-17-reshape-exports.py
"""

import json
import os
import sys

import pandas as pd

# --- config -----------------------------------------------------------------
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "data")

RAW = os.path.join(DATA, "clean_tech_exports_full_release_monthly.csv")
CENTROIDS = os.path.join(DATA, "country-centroids.json")
OUT_TIDY = os.path.join(DATA, "2026-06-17-reshaped-solar-by-destination.csv")
OUT_JSON = os.path.join(DATA, "flows.json")
OUT_MONTHLY = os.path.join(DATA, "flows-monthly.json")

# Assumption for the *estimated* GW column. ~US$0.10/W reflects 2025 Chinese
# module export prices. Stated explicitly; the UI leads with USD value.
USD_PER_WATT = 0.10

START_MONTH = "2023-01-01"   # map/animation window
N_TOP_GLOBAL = 30            # top global solar destinations for the flow map
N_TOP_AFRICA = 15            # African destinations for the Africa step
CATS_FOR_CODA = ["Solar PV", "EVs", "Batteries", "Wind"]
REGIONS = ["Africa", "Asia", "Europe", "Middle East",
           "Latin America and Caribbean", "North America", "Oceania"]


def usd_to_gw(usd):
    """Convert export value (USD) to an estimated GW of modules."""
    return round(usd / USD_PER_WATT / 1e9, 3)


def m(usd):
    """USD -> USD millions, 1 dp."""
    return round(usd / 1e6, 1)


def main():
    if not os.path.exists(RAW):
        sys.exit(
            f"Raw CSV not found at:\n  {RAW}\n\n"
            "Download 'China Cleantech Data - by technology category (CSV)' from\n"
            "https://ember-energy.org/data/china-cleantech-export-data/\n"
            "and save it into the data/ folder with that exact filename."
        )

    df = pd.read_csv(RAW)
    df.columns = [c.strip() for c in df.columns]
    df = df.rename(columns={
        "Area": "area", "Date": "date", "Area type": "area_type",
        "Region": "region", "Commodity category": "category",
        "Amount (USD)": "usd",
    })
    df["date"] = pd.to_datetime(df["date"]).dt.strftime("%Y-%m-%d")
    df["usd"] = pd.to_numeric(df["usd"], errors="coerce").fillna(0.0)

    countries = df[df["area_type"] == "Country or economy"].copy()
    all_dates = sorted(df["date"].unique())
    last12 = all_dates[-12:]
    months = [d for d in all_dates if d >= START_MONTH]

    # --- tidy long table (all categories, country level) --------------------
    tidy = countries[["area", "region", "date", "category", "usd"]].copy()
    tidy = tidy.rename(columns={"usd": "usd_value"})
    tidy["solar_gw_est"] = tidy.apply(
        lambda r: usd_to_gw(r["usd_value"]) if r["category"] == "Solar PV" else "",
        axis=1,
    )
    tidy = tidy.sort_values(["area", "category", "date"])
    tidy.to_csv(OUT_TIDY, index=False)
    print(f"wrote {OUT_TIDY}  ({len(tidy):,} rows)")

    # --- helpers ------------------------------------------------------------
    solar_c = countries[countries["category"] == "Solar PV"]

    def monthly_series(frame):
        """Sum usd by month over `months`, return list aligned to `months`."""
        g = frame.groupby("date")["usd"].sum()
        return [m(float(g.get(d, 0.0))) for d in months]

    # top global + top africa solar destinations (by last-12-month value)
    l12 = solar_c[solar_c["date"].isin(last12)]
    glob_tot = l12.groupby("area")["usd"].sum().sort_values(ascending=False)
    top_global = list(glob_tot.head(N_TOP_GLOBAL).index)
    afr_tot = (l12[l12["region"] == "Africa"].groupby("area")["usd"].sum()
               .sort_values(ascending=False))
    top_africa = list(afr_tot.head(N_TOP_AFRICA).index)
    union = list(dict.fromkeys(top_global + top_africa))  # preserve order, dedupe

    with open(CENTROIDS, encoding="utf-8") as f:
        cen = json.load(f)

    region_of = dict(zip(countries["area"], countries["region"]))

    country_objs, missing = [], []
    for name in union:
        coord = cen.get(name)
        if not coord:
            missing.append(name)
            continue
        sub = solar_c[solar_c["area"] == name]
        country_objs.append({
            "name": name,
            "region": region_of.get(name, ""),
            "lonlat": coord,
            "solar_monthly": monthly_series(sub),
            "solar_last12": m(float(glob_tot.get(name, afr_tot.get(name, 0.0)))),
        })
    if missing:
        print("WARNING: no centroid for (dropped from map): " + ", ".join(missing))

    # region solar monthly
    region_rows = df[(df["area_type"] == "Region") & (df["category"] == "Solar PV")]
    regions_solar = {rg: monthly_series(region_rows[region_rows["area"] == rg])
                     for rg in REGIONS}

    # world totals by category (the coda)
    world_rows = df[df["area"] == "World"]
    world_by_cat = {c: monthly_series(world_rows[world_rows["category"] == c])
                    for c in CATS_FOR_CODA}

    # africa focus callouts (Feb/Mar/Apr 2026 + last12 + est GW for the spike month)
    spike, prev, after = "2026-03-01", "2026-02-01", "2026-04-01"

    def val(name, d):
        r = solar_c[(solar_c["area"] == name) & (solar_c["date"] == d)]["usd"]
        return float(r.iloc[0]) if len(r) else 0.0

    africa_focus = []
    for name in top_africa[:8]:
        africa_focus.append({
            "name": name,
            "feb26": m(val(name, prev)),
            "mar26": m(val(name, spike)),
            "apr26": m(val(name, after)),
            "last12": m(float(afr_tot.get(name, 0.0))),
            "mar26_gw_est": usd_to_gw(val(name, spike)),
        })

    payload = {
        "meta": {
            "source": "Ember China Cleantech Export Data (by technology category)",
            "source_url": "https://ember-energy.org/data/china-cleantech-export-data/",
            "license": "CC-BY-4.0",
            "units": "USD millions",
            "gw_assumption_usd_per_watt": USD_PER_WATT,
            "generated": "2026-06-17",
            "latest_month": all_dates[-1],
            "note": ("China cleantech exports by destination. Values are monthly "
                     "export value in USD millions. solar_gw_est is an ESTIMATE "
                     f"using US${USD_PER_WATT}/W."),
        },
        "months": months,
        "countries": country_objs,
        "regionsSolarMonthly": regions_solar,
        "worldByCatMonthly": world_by_cat,
        "africaFocus": africa_focus,
    }

    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(payload, f, separators=(",", ":"))
    print(f"wrote {OUT_JSON}  ({len(country_objs)} countries, {len(months)} months)")

    # compact per-country monthly file consumed by the timeline scrubber
    # shape: {"months": [...], "series": {country_name: [int $M per month]}}
    monthly_payload = {
        "months": months,
        "series": {
            c["name"]: [int(round(v)) for v in c["solar_monthly"]]
            for c in country_objs
        },
    }
    with open(OUT_MONTHLY, "w", encoding="utf-8") as f:
        json.dump(monthly_payload, f, separators=(",", ":"))
    print(f"wrote {OUT_MONTHLY}  ({len(country_objs)} countries, {len(months)} months)")


if __name__ == "__main__":
    main()
