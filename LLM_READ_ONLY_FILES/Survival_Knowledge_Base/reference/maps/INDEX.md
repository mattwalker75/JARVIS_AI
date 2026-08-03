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

## `north-texas/` — street level + regional (24 files)
> 📍 **Open [`north-texas/COVERAGE.md`](north-texas/COVERAGE.md) first** — it lists every map here and the exact area it covers, so you can pick the one file you need without opening any 30–60 MB PDF.

**Street-level — USGS US Topo 7.5-minute GeoPDF quads** (1:24,000, 2022 editions, public domain — USGS), each one 7.5-minute quadrangle over an aerial-photo base with labeled roads, railroads, water, and contours.

*Anna / Collin County home cluster:* `ustopo_anna_tx.pdf` (home; incl. Melissa), `ustopo_van_alstyne_tx.pdf`, `ustopo_weston_tx.pdf`, `ustopo_blue_ridge_tx.pdf`, `ustopo_howe_tx.pdf`, `ustopo_mckinney_east_tx.pdf`, `ustopo_mckinney_west_tx.pdf`, `ustopo_farmersville_tx.pdf`, `ustopo_josephine_tx.pdf`, `ustopo_lavon_tx.pdf` (Lavon Lake).

*North corridor, Anna → Sherman/Denison → Red River (Oklahoma border), along US-75:* `ustopo_dorchester_tx.pdf`, `ustopo_gunter_tx.pdf`, `ustopo_collinsville_tx.pdf`, `ustopo_sherman_tx.pdf` (Sherman), `ustopo_sherman_nw_tx.pdf`, `ustopo_denison_dam_tx.pdf` (Denison / Red River / Lake Texoma), `ustopo_pottsboro_tx.pdf` (Lake Texoma), `ustopo_gordonville_tx.pdf` (Red River), `ustopo_sadler_tx.pdf`, `ustopo_whitewright_tx.pdf`.

**Regional / egress — TxDOT road maps** (every road, wider scale; Texas state public records):

| File | What it is |
|---|---|
| `txdot_collin_county.pdf` | TxDOT official Collin County map book (16 grid tiles + legend, merged) — every county/local road in Collin County |
| `txdot_dallas_district.pdf` | TxDOT Dallas District — Collin, **Dallas**, **Denton**, Ellis, Kaufman, Navarro, Rockwall counties (east/core DFW) |
| `txdot_fortworth_district.pdf` | TxDOT Fort Worth District — **Tarrant**, Parker, Johnson, Hood, Somervell, Wise, Erath, Palo Pinto, Jack counties (west DFW) |
| `txdot_paris_district.pdf` | TxDOT Paris District — **Grayson** (Sherman/Denison), **Fannin**, **Hunt**, Lamar, Delta, Hopkins, Rains, Red River, Franklin counties (north to the Oklahoma border, northeast toward Paris) |

Together the Dallas + Fort Worth district maps cover the whole DFW Metroplex; the Paris district map continues north through Grayson County to the Red River / Oklahoma line.

---

## How to use these
- **As a person:** open the tier you need. Planning a long trip → `national/`. Crossing a state → that `states/` file. Getting around near Anna → the matching `north-texas/` quad (start with `ustopo_anna_tx.pdf`). Print the ones you care about while you still can.
- **With the offline LLM:** ask it to read the relevant map (`read_document` on the PDF) and describe routes, road numbers, or nearby features. The North Texas topos are aerial-photo GeoPDFs, so the LLM can also `analyze_image` a rendered page for landmarks.
- **Orient yourself first:** use the [Navigation guide](../../topics/navigation/navigation.md) to find North (sun, Polaris, a compass) before reading any map, and match map features to what you see on the ground.

**Licensing:** all files are US-government public-domain works (FHWA, USGS) or a state public record (TxDOT), included for offline emergency reference.
