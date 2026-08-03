# Local Emergency Reference — Index

Local emergency data for navigating a disaster when the internet is down — **emergency numbers, weather-radio frequencies, state emergency-management agencies, road info, shelters, and state-specific hazards**. Coverage is **all 50 states**, in two tiers. Use these with the [START HERE](../../START-HERE.md) card, the [Communication Frequencies](../comms-frequencies.md) reference, and the offline [Maps](../maps/INDEX.md).

> ⚠️ **This is contact data — it goes stale.** Phone numbers, frequencies, providers, and agency names change. Every sheet is date-stamped (Compiled 2026-08) and cites official sources; anything that couldn't be verified is marked **"verify locally."** In a life-threatening emergency, **call 911** if phones work.
>
> **National constants (stable):** Poison Control **1-800-222-1222** · Suicide & Crisis Lifeline **988** · Disaster Distress Helpline **1-800-985-5990** · health/human-services **211** · traveler/road info **511** (where offered) · NOAA Weather Radio band = one of 162.400 / .425 / .450 / .475 / .500 / .525 / .550 MHz (local transmitter sets the channel).

## Two tiers

**Deep sheets** — full detail for the home region (utility outage & gas-leak numbers, trauma centers, ham repeaters, per-metro blocks):

| State | Sheet |
|---|---|
| **Texas** (incl. DFW / Collin County / **Anna**) | [texas.md](texas.md) |
| **Oklahoma** | [oklahoma.md](oklahoma.md) |
| **Arkansas** | [arkansas.md](arkansas.md) |

**Home-area road & egress sheet** — a no-map-needed "where am I / how do I get out" companion for the Anna home base (main roads, cardinal egress routes, hospitals/ERs, water bodies, Red River crossings into Oklahoma, flat-country landmarks). Pairs with the [offline maps](../maps/INDEX.md) and their [coverage index](../maps/north-texas/COVERAGE.md):

| Area | Sheet |
|---|---|
| **Anna / Collin & Grayson County** (roads, landmarks, egress) | [north-texas-anna-roads.md](north-texas-anna-roads.md) |

**Light sheets** — the other **47 states**, with the *durable* essentials only (state emergency-management agency + website, NWS forecast offices, NOAA Weather Radio band, state DOT/511 road info, American Red Cross region, and each state's main hazards). Deliberately **no** fragile per-utility phone numbers, hospital lists, or repeater frequencies — those go stale fastest and are best verified locally at the time.

Files are named `<state>.md` (e.g. `ohio.md`, `new-york.md`, `north-carolina.md`, `rhode-island.md`) — one per state, all 50 present.

## Why two tiers
Local reference is most useful where you actually are; the home region gets full depth, while every other state gets a durable baseline so the offline assistant can still answer "who runs emergencies here, what are the weather-radio and road-info sources, and what should I prepare for" anywhere in the US. For getting *between* places, the [offline road maps](../maps/INDEX.md) cover all 50 states. To upgrade any light sheet to a deep one (utilities, hospitals, repeaters), just ask.

**How to use with the offline LLM:** for a location-specific question, open the matching `reference/local/<state>.md` alongside the relevant topic guide. TX/OK/AR give the most detail; other states give the agency/website/frequency baseline plus "verify locally" where a specific value couldn't be confirmed.
