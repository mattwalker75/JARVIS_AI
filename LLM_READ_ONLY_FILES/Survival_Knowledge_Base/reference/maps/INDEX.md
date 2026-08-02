# Offline Maps — Index

Public-domain road, highway, and street maps for navigating **without internet or GPS**. All files are PDF (or JPG) — readable by a person in any viewer and by an offline LLM, no connection required. Pair these with the [Navigation Without GPS](../../topics/navigation/navigation.md) guide.

**Three tiers, by zoom level:**

| Tier | Folder | Detail level | Use it for |
|---|---|---|---|
| National | `national/` | Whole US, interstates + major highways | Cross-country routing, knowing which interstate goes where |
| State | `states/` | One map per state, highway/arterial level | Getting between towns and across a state without GPS |
| North Texas | `north-texas/` | Street level (1:24,000) for the Anna / Collin County home region | Walking/driving individual roads near home |

> ⚠️ **Coverage honesty.** The **national and state** maps show highways and major roads — enough to travel between towns, **not** every residential street. True **street-level** detail is only provided for the **North Texas home region** (`north-texas/`). Whole-country street-level maps can't be static files (they'd be terabytes); for turn-by-turn streets anywhere in the US, install an offline map app (e.g. **OsmAnd** or **Organic Maps**) and download its OpenStreetMap data onto your phone **before** an outage.

---

## `national/` — nationwide (3 files)
| File | What it is | Source / license |
|---|---|---|
| `fhwa_national_highway_system_map.pdf` | FHWA National Highway System — Interstates, STRAHNET routes, intermodal connectors across the whole US | FHWA (US federal, public domain) |
| `us_interstate_highway_system_map.jpg` | Map of the entire US Interstate Highway System (all numbered interstates) | Wikimedia Commons, built from National Atlas federal data (public domain) |
| `usgs_national_atlas_general_reference_map.pdf` | USGS National Atlas general reference map — states, boundaries, major cities and highways | USGS (US federal, public domain) |

## `states/` — every US state (50 files)
One highway map per state, named `<state>.pdf` (e.g. `texas.pdf`, `new-mexico.pdf`, `north-carolina.pdf`). All 50 states are present. Each is the **FHWA National Highway System statewide map** (US federal, public domain) — showing that state's interstates, principal arterials, STRAHNET routes, cities, airports, and rail/port facilities, with a legend and mileage scale.

## `north-texas/` — street level for the home region (11 files)
**USGS US Topo 7.5-minute GeoPDF quads** (1:24,000, 2022 editions, public domain — USGS), each covering one 7.5-minute quadrangle at street level over an aerial-photo base, with labeled roads, railroads, water, and contour lines:

| File | Quadrangle (also covers) |
|---|---|
| `ustopo_anna_tx.pdf` | **Anna** (home quad; includes Melissa) |
| `ustopo_van_alstyne_tx.pdf` | Van Alstyne (north) |
| `ustopo_weston_tx.pdf` | Weston (west) |
| `ustopo_blue_ridge_tx.pdf` | Blue Ridge (east) |
| `ustopo_howe_tx.pdf` | Howe (north, Grayson Co. border) |
| `ustopo_mckinney_east_tx.pdf` | McKinney East (south) |
| `ustopo_mckinney_west_tx.pdf` | McKinney West (southwest) |
| `ustopo_farmersville_tx.pdf` | Farmersville (southeast) |
| `ustopo_josephine_tx.pdf` | Josephine (southeast) |
| `ustopo_lavon_tx.pdf` | Lavon (south, Lavon Lake area) |

Plus a county-wide road reference:

| File | What it is | Source / license |
|---|---|---|
| `txdot_collin_county.pdf` | TxDOT official Collin County map book (16 grid tiles + legend, merged) — every county/local road in Collin County | Texas DOT (state public record) |

---

## How to use these
- **As a person:** open the tier you need. Planning a long trip → `national/`. Crossing a state → that `states/` file. Getting around near Anna → the matching `north-texas/` quad (start with `ustopo_anna_tx.pdf`). Print the ones you care about while you still can.
- **With the offline LLM:** ask it to read the relevant map (`read_document` on the PDF) and describe routes, road numbers, or nearby features. The North Texas topos are aerial-photo GeoPDFs, so the LLM can also `analyze_image` a rendered page for landmarks.
- **Orient yourself first:** use the [Navigation guide](../../topics/navigation/navigation.md) to find North (sun, Polaris, a compass) before reading any map, and match map features to what you see on the ground.

**Licensing:** all files are US-government public-domain works (FHWA, USGS) or a state public record (TxDOT), included for offline emergency reference.
