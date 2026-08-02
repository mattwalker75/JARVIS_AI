---
title: "Radio Frequency Reference Card — NOAA, FRS/GMRS, MURS, CB, and Amateur (Ham)"
topic: comms-frequencies
tags: [radio, frequencies, NOAA weather radio, NWR, SAME, FRS, GMRS, MURS, CB, citizens band, amateur radio, ham radio, repeater, simplex, calling frequency, CTCSS, PL tone, SKYWARN, ARES, RACES, marine VHF, FCC, part 95, part 97, emergency communication, grid-down]
summary: >
  A verified, FCC-sourced channel/frequency card for emergency and survival radio use — NOAA Weather
  Radio's 7 channels and SAME alerting, the full 22 FRS/GMRS channels with power limits and GMRS
  repeater pairs, the 5 MURS channels, all 40 CB channels, key amateur (ham) 2m/70cm calling
  frequencies and band plans with standard repeater offsets, and what to monitor (SKYWARN, ARES/RACES,
  marine VHF Ch16) in a disaster — plus which services need a license and the genuine life-threatening
  emergency exception.
regions: [general, urban, suburban, rural, north-texas]
difficulty: beginner
reading_time: 22 min
see_also: [../topics/communication/communication.md, ../topics/signaling-rescue/signaling-rescue.md, local/INDEX.md]
sources: [FCC 47 CFR Part 95 (Personal Radio Services — FRS/GMRS/MURS/CB), FCC 47 CFR Part 97 (Amateur Radio Service), NOAA/NWS Weather Radio, ARRL Band Plan, NWS SKYWARN]
---

# Radio Frequency Reference Card — NOAA, FRS/GMRS, MURS, CB, and Amateur (Ham)

## Read this first (the 30-second version)
1. **Cell towers and the internet fail before radio does.** A battery/hand-crank radio that receives **NOAA Weather Radio** (7 fixed channels, ~162.4–162.55 MHz) gets you official alerts with no license and no internet.
2. **For talking to your group**, a cheap walkie-talkie set covers **FRS** (license-free) with **22 channels**; adding **GMRS** (cheap $35 license, no test, covers your family, more power and repeater access) extends real-world range from ~1 mile to several miles or more with a repeater.
3. **MURS** and **CB** are two other license-free options — MURS (5 VHF channels) is quieter and better for short-range group use; **CB Channel 9** is the recognized emergency/motorist-assistance channel and **Channel 19** is the trucker/highway-info channel.
4. **Amateur ("ham") radio** needs a license **and passing a written exam**, but gives the longest range, the most channels, repeater networks, and even long-distance HF — the single best "find out what's happening" and "reach someone far away" tool if you or someone in your group is licensed.
5. **In a genuine life-threatening emergency, FCC rules let anyone use any radio on any frequency** — including GMRS or ham frequencies without a license — to get help, when no other means is available. This is the *exception*, not routine practice.

---

## Why this matters
When phone networks, cell towers, and the internet are down or overloaded (storms, hurricanes, wildfires, grid failure, mass-casualty events), radio is often the **only** communication path left — it doesn't depend on towers being powered or unclogged, and a battery-powered receiver can run for days. Knowing the right **frequency or channel number** in advance matters because in an emergency you may not have signal to look it up, and different services (FRS, GMRS, MURS, CB, ham) each have their own channel numbering and rules — mixing them up means you transmit on the wrong frequency, use illegal power, or simply can't reach the person you're trying to talk to. This card gives the exact, FCC-verified numbers so a person — or an offline assistant with no internet access — can read them directly off the page.

## Key terms (plain language)
- **Simplex** — both radios transmit and receive on the *same* single frequency, talking directly to each other with no repeater. Works line-of-sight; range is limited by terrain and antenna height.
- **Repeater** — a fixed station, usually on a tower/hilltop, that receives on one frequency and instantly retransmits on another, greatly extending range for handheld radios. Uses an **input** (what you transmit) and **output** (what you listen to), separated by a fixed **offset**.
- **Offset** — the fixed frequency gap between a repeater's input and output (e.g., 2m ham repeaters commonly use ±600 kHz; GMRS repeaters always use +5.000 MHz).
- **CTCSS / "PL tone"** — a quiet sub-audible tone added to your transmission so a repeater (or another radio) only opens up for signals carrying the right tone; it is **not** privacy or encryption — anyone can hear you if they aren't using tone squelch. PL = "Private Line," a Motorola trademark for CTCSS.
- **ERP** — effective radiated power, the FCC's measure of a transmitter's legal power limit (accounts for antenna gain, not just the radio's wattage).
- **SAME** — Specific Area Message Encoding, the digital code NOAA Weather Radios use to alert only for your specific county/area instead of an entire region.
- **License by rule** — a radio service (FRS, MURS, CB) you're automatically authorized to use just by following the rules, with **no application, no fee, and no test**.
- **Net** — a scheduled, organized on-air radio session (e.g., a SKYWARN net or an ARES net) with a net control station coordinating traffic.

---

# NOAA Weather Radio (NWR)

Seven fixed VHF frequencies nationwide, all in the 162 MHz "weather band." Every radio sold as a "weather radio" in the US receives all seven; **you must find which one your local NWS transmitter uses.**

| NWR Channel (device label) | Frequency (MHz) |
|---|---|
| WX1 | 162.400 |
| WX2 | 162.425 |
| WX3 | 162.450 |
| WX4 | 162.475 |
| WX5 | 162.500 |
| WX6 | 162.525 |
| WX7 | 162.550 |

- **Range:** typically usable up to ~40 miles from the transmitter, less with hills/buildings in the way.
- **Finding your local one:** check the NWS station listing at weather.gov/nwr, scan all 7 channels on your radio and keep the clearest one, or ask your county emergency management office. Note the frequency down on paper — don't rely on remembering the channel number, since manufacturers sometimes number channels differently even though the actual frequencies are standardized.
- **SAME alerting:** modern NOAA radios can be programmed with your **county's 6-digit SAME/FIPS code** so the radio stays silent until an alert is issued specifically for your county, then sounds an alarm and unmutes automatically — even overnight. Program every county you live in, work in, or travel through.
- **What you'll hear:** continuous weather info/forecasts, and — when active — the **Emergency Alert System (EAS)** relay for severe weather, and in many areas also non-weather emergencies (Amber Alerts, hazmat, civil emergencies) that NWS agrees to relay.

---

# FRS / GMRS — the 22 shared channels

FRS (Family Radio Service) and GMRS (General Mobile Radio Service) share one 22-channel numbering plan under FCC Part 95. **FRS needs no license at all. GMRS needs a license (see below) for higher power and repeater use**, but the frequencies themselves are largely shared.

| Ch | Frequency (MHz) | Service | Max power (FRS) | Max power (GMRS) | Notes |
|----|------------------|---------|------------------|-------------------|-------|
| 1 | 462.5625 | Shared | 2 W | 5 W | |
| 2 | 462.5875 | Shared | 2 W | 5 W | |
| 3 | 462.6125 | Shared | 2 W | 5 W | |
| 4 | 462.6375 | Shared | 2 W | 5 W | |
| 5 | 462.6625 | Shared | 2 W | 5 W | |
| 6 | 462.6875 | Shared | 2 W | 5 W | |
| 7 | 462.7125 | Shared | 2 W | 5 W | |
| 8 | 467.5625 | Shared, low-power only | 0.5 W | 0.5 W | Handheld only; no repeater use |
| 9 | 467.5875 | Shared, low-power only | 0.5 W | 0.5 W | Handheld only; no repeater use |
| 10 | 467.6125 | Shared, low-power only | 0.5 W | 0.5 W | Handheld only; no repeater use |
| 11 | 467.6375 | Shared, low-power only | 0.5 W | 0.5 W | Handheld only; no repeater use |
| 12 | 467.6625 | Shared, low-power only | 0.5 W | 0.5 W | Handheld only; no repeater use |
| 13 | 467.6875 | Shared, low-power only | 0.5 W | 0.5 W | Handheld only; no repeater use |
| 14 | 467.7125 | Shared, low-power only | 0.5 W | 0.5 W | Handheld only; no repeater use |
| 15 | 462.5500 | Shared | 2 W | 50 W (mobile/base/repeater only; handhelds 5 W) | GMRS repeater **output**; pairs with 15R below |
| 16 | 462.5750 | Shared | 2 W | 50 W (mobile/base/repeater only; handhelds 5 W) | GMRS repeater output |
| 17 | 462.6000 | Shared | 2 W | 50 W (mobile/base/repeater only; handhelds 5 W) | GMRS repeater output |
| 18 | 462.6250 | Shared | 2 W | 50 W (mobile/base/repeater only; handhelds 5 W) | GMRS repeater output |
| 19 | 462.6500 | Shared | 2 W | 50 W (mobile/base/repeater only; handhelds 5 W) | GMRS repeater output |
| 20 | 462.6750 | Shared | 2 W | 50 W (mobile/base/repeater only; handhelds 5 W) | GMRS repeater output |
| 21 | 462.7000 | Shared | 2 W | 50 W (mobile/base/repeater only; handhelds 5 W) | GMRS repeater output |
| 22 | 462.7250 | Shared | 2 W | 50 W (mobile/base/repeater only; handhelds 5 W) | GMRS repeater output |
| 15R–22R | 467.5500–467.7250 | GMRS only | — | 50 W (mobile/base/repeater only; handhelds 5 W) | **Repeater input channels** — always **+5.000 MHz** above the matching 15–22 output. Your radio transmits here; you listen on the matching output above. |

**Notes:**
- Channels **1–7** and **15–22** are FRS/GMRS shared "main" channels; FRS units are capped at 2 W on all of them, while a licensed GMRS station can run up to 5 W on 1–7 and up to 50 W (mobile/base/repeater) on 15–22.
- Channels **8–14** are the low-power "interstitial" channels — both FRS and GMRS are capped at 0.5 W here, hand-held only, and repeater operation is not permitted.
- **GMRS repeaters** almost always operate on channels 15–22, transmitting (from the repeater) on the plain 462 MHz channel and listening on the paired 467 MHz input 5.000 MHz higher — this fixed **+5 MHz offset** is the GMRS standard, similar in concept to a ham repeater offset.
- **GMRS license:** required to legally use GMRS power levels/repeaters. **No test.** $35 (as of this writing) via the FCC's online licensing system (Form 605), valid **10 years**, and it automatically covers the licensee's **immediate family** (spouse, kids, parents, siblings, in-laws, etc.) — one license per household is enough. **FRS needs no license at all**, at any power level FRS radios are permitted.
- **Range reality:** cheap FRS/GMRS handhelds advertised as "35 miles" realistically get **0.5–2 miles** in neighborhoods/woods/hilly terrain, maybe 5+ miles with clear line of sight (open field, hilltop to hilltop), and much farther through a GMRS repeater if one is available and you're within its coverage.

---

# MURS — Multi-Use Radio Service

Five VHF channels, **license-free**, no test, no fee, no age restriction — a quieter alternative to FRS/GMRS since it's a separate, less-crowded slice of spectrum.

| Ch | Frequency (MHz) | Notes |
|----|------------------|-------|
| 1 | 151.820 | Narrowband, MURS-exclusive (no legacy business users) |
| 2 | 151.880 | Narrowband, MURS-exclusive |
| 3 | 151.940 | Narrowband, MURS-exclusive |
| 4 ("Blue Dot") | 154.570 | Wider bandwidth allowed; former business-band channel |
| 5 ("Green Dot") | 154.600 | Wider bandwidth allowed; former business-band channel |

- Max power **2 W**; external antennas are allowed (unlike FRS), which can meaningfully extend range — a real advantage over FRS for a fixed base station.
- No repeaters permitted; MURS is simplex only.
- Good option for a family/property/neighborhood-watch channel that won't be crowded with FRS/GMRS chatter.

---

# CB — Citizens Band Radio

Forty channels, **26.965–27.405 MHz**, 10 kHz spacing, **no license required** ("licensed by rule").

| Ch | MHz | Ch | MHz | Ch | MHz | Ch | MHz |
|----|-----|----|-----|----|-----|----|-----|
| 1 | 26.965 | 11 | 27.085 | 21 | 27.215 | 31 | 27.315 |
| 2 | 26.975 | 12 | 27.105 | 22 | 27.225 | 32 | 27.325 |
| 3 | 26.985 | 13 | 27.115 | 23 | 27.255 | 33 | 27.335 |
| 4 | 27.005 | 14 | 27.125 | 24 | 27.235 | 34 | 27.345 |
| 5 | 27.015 | 15 | 27.135 | 25 | 27.245 | 35 | 27.355 |
| 6 | 27.025 | 16 | 27.155 | 26 | 27.265 | 36 | 27.365 |
| 7 | 27.035 | 17 | 27.165 | 27 | 27.275 | 37 | 27.375 |
| 8 | 27.055 | 18 | 27.175 | 28 | 27.285 | 38 | 27.385 |
| 9 | **27.065** | 19 | **27.185** | 29 | 27.295 | 39 | 27.395 |
| 10 | 27.075 | 20 | 27.205 | 30 | 27.305 | 40 | 27.405 |

- **Channel 9 (27.065 MHz) — the designated emergency / motorist-assistance channel.** Reserved for emergencies and getting roadside help; don't use it for chit-chat.
- **Channel 19 (27.185 MHz) — the trucker/highway channel.** De facto standard for road conditions, traffic, accidents, speed traps — a good one to monitor while driving or evacuating by road.
- **Power limits:** 4 watts carrier power max on AM/FM, 12 watts PEP (peak envelope power) max on SSB. Linear amplifiers ("linears") are illegal on CB.
- **SSB (single sideband):** an optional mode on some CB radios giving more effective range/clarity than AM at the same legal power; commonly used on the upper channels (e.g., 36–40) by SSB-equipped radios — but plain AM CB is what most people have, and AM and SSB users can't talk to each other directly on the same channel (different mode).
- **Range reality:** typically 1–5 miles depending on terrain/antenna, more on open highway or with a good base antenna; CB signals can occasionally "skip" hundreds of miles during atmospheric conditions (usually a nuisance for local use, but shows the band is still alive when local infrastructure is down).

---

# Amateur ("Ham") Radio — key survival frequencies

Amateur radio requires an FCC license **and passing a written exam** (Technician class is the entry level and covers VHF/UHF privileges used below), but rewards you with far more channels, repeater networks, digital modes, and long-distance HF capability.

## National simplex calling frequencies (memorize these two)
| Band | Frequency | Use |
|---|---|---|
| **2 meters (VHF)** | **146.520 MHz** | National FM simplex calling frequency — the first place to listen/call when you don't know a local frequency |
| **70 centimeters (UHF)** | **446.000 MHz** | National FM simplex calling frequency (UHF equivalent) |

## 2 meter (144–148 MHz) band plan, simplified
| Segment | Use |
|---|---|
| 144.00–144.10 | CW / weak-signal (EME, etc.) |
| 144.10–144.275 | SSB weak-signal; 144.200 is the national SSB calling frequency |
| 144.30–144.50 | Satellite (OSCAR) sub-band |
| 144.50–144.90 | Repeater **inputs** (linear translator inputs, then FM repeater inputs) |
| 145.10–145.50 | Repeater **outputs** (linear translator outputs, then FM repeater outputs) |
| 145.50–145.80 | Miscellaneous / experimental |
| 145.80–146.00 | Satellite (OSCAR) sub-band |
| 146.01–146.37 | Repeater inputs |
| 146.40–146.58 | **Simplex** (146.520 is the national calling frequency within this range) |
| 146.61–147.39 | Repeater inputs/outputs (varies by region) |

- **Standard 2m repeater offset: ±600 kHz** (0.6 MHz) — some regions use plus, others minus, by convention/coordination for that area.

## 70 cm (420–450 MHz) band plan, simplified
| Segment | Use |
|---|---|
| 420–432 | Weak-signal, ATV (varies by region) |
| 432–433 | Weak-signal SSB/CW |
| 442–445 | Repeater inputs/outputs (local option; varies by region) |
| 445–447 | Shared: repeaters, simplex, and auxiliary/control links (local option) |
| ~446.000 | **National simplex calling frequency** |
| 447–450 | Repeater inputs/outputs (varies by region) |

- **Standard 70cm repeater offset: ±5 MHz** — like 2m, exact input/output split depends on regional band-plan coordination.
- **Regional variation matters:** unlike FRS/GMRS/MURS/CB, ham VHF/UHF band plans are locally coordinated (by regional frequency coordinating bodies), so exact repeater sub-bands shift somewhat by area — the calling frequencies (146.520, 446.000) and standard offsets (±600 kHz, ±5 MHz) are the reliable, nationwide constants.

## CTCSS / "PL tones"
Most repeaters require a specific CTCSS (sub-audible) tone on your transmission to activate them; look up the local repeater's tone (via ARRL repeater directory, RepeaterBook, or a local club) and program it into your radio. Remember: **it is not privacy** — anyone can still hear you without the tone if their radio isn't using tone squelch.

## HF for long distance (brief)
When VHF/UHF and repeaters are all down or out of range, **HF (High Frequency)** bands can carry a signal across a state, the country, or the world depending on time of day and propagation:
- **40 meters (~7.0–7.3 MHz)** — reliable regional/continental range, day or night; a workhorse band for emergency traffic nets.
- **80 meters (~3.5–4.0 MHz)** — best at night for regional coverage (a few hundred miles).
- HF requires a General or Amateur Extra class license for most of these voice sub-bands (a few narrow Technician HF privileges exist), a suitable antenna, and practice — it's a deeper investment than VHF/UHF handhelds, but it's the only option here that doesn't depend on any repeater or nearby infrastructure at all.

---

# Emergency nets and what to monitor in a disaster

- **SKYWARN** — a National Weather Service volunteer storm-spotting program. Many local hams participate, reporting severe weather (tornadoes, hail, flooding) directly to the NWS by radio during active severe-weather events, usually on a local repeater's "SKYWARN net." Monitoring your area's SKYWARN net during storms gives you real-time, on-the-ground reports before/faster than official warnings sometimes arrive.
- **ARES (Amateur Radio Emergency Service)** — ARRL-sponsored volunteer hams who provide backup emergency communication for served agencies (Red Cross, emergency management, hospitals) when normal systems fail.
- **RACES (Radio Amateur Civil Emergency Service)** — a similar volunteer ham emergency communication corps, operating under local/state emergency management and FEMA authorization, activated specifically during declared emergencies.
- **What to monitor in a disaster, in priority order:** (1) your local NOAA Weather Radio channel, (2) your county's public-safety/EAS broadcast (also relayed on local AM/FM stations), (3) a local ham repeater known to host SKYWARN/ARES nets during the event, (4) CB Channel 19 if you're near/on a highway, (5) GMRS repeater or MURS channel your own group has agreed on in advance.
- **Marine VHF Channel 16 (156.800 MHz)** — the international marine distress, safety, and calling channel, monitored by the Coast Guard and vessels. Relevant if you're near open water/boating, or as a general aside: it's continuously monitored infrastructure that keeps working when other systems don't. Requires a VHF marine radio (not the same band as FRS/GMRS/ham 2m); recreational boaters generally don't need an individual license to use it.

## If you have only a cheap radio, program these
A minimal, high-value list for a basic handheld/scanner:
1. **NOAA Weather Radio** — all 7 (162.400–162.550 MHz); find and mark your local one.
2. **FRS/GMRS Channel 1** (462.5625 MHz) and **Channel 20** (462.6750 MHz) — one main-channel, one GMRS-repeater-capable channel, as family default channels.
3. **CB Channel 9** (27.065 MHz, emergency) and **Channel 19** (27.185 MHz, highway) if your radio covers CB.
4. **Ham 2m calling frequency 146.520 MHz** and **70cm calling frequency 446.000 MHz**, plus your nearest known repeater's output/input/tone, if you or someone with you is licensed.
5. **Marine Channel 16 (156.800 MHz)** if you're anywhere near water.

---

# ⚠️ Safety / legal
- **FRS, MURS, and CB require NO license** — anyone can use them, at any time, for any legal purpose, right out of the box.
- **GMRS requires an FCC license** — $35, **no test**, valid 10 years, covers your immediate family. It is illegal to transmit on GMRS-only frequencies/power levels (channels 15–22 above 2 W, or the 15R–22R repeater inputs) without one.
- **Amateur (ham) radio requires an FCC license AND passing a written examination** (Technician class minimum for the VHF/UHF frequencies in this guide; General/Extra for most HF voice privileges). It is illegal to transmit on amateur frequencies without a license.
- **The genuine emergency exception:** FCC rules (47 CFR §97.403/§97.405 for amateur radio, and the general FCC principle recognized across radio services) allow **any person to use any means of radiocommunication at their disposal — including transmitting on ham or GMRS frequencies without a license — when there is an immediate, genuine threat to human life or property and no other means of communication is available.** This is a real, narrow safety-of-life exception, not a loophole for routine unlicensed use — reserve it for actual emergencies, and return to licensed/authorized operation once the emergency has passed.
- **Do not transmit false distress calls or "test" emergency channels** (CB Ch 9, marine Ch 16, ham calling frequencies) for non-emergencies — this is illegal and endangers real emergency traffic.
- **CTCSS/PL tones are not privacy or encryption** — assume anything you transmit on any of these services can be overheard by anyone with a compatible receiver.
- Respect licensed users and repeater owners: identify appropriately if licensed, keep transmissions relevant, and yield to genuine emergency traffic immediately.

# Troubleshooting
| Problem | Likely cause / fix |
|---|---|
| NOAA weather radio only hisses/static | Wrong channel for your area — scan all 7 (162.400–162.550) and note the clearest one; move the antenna or go to a higher/window location. |
| FRS/GMRS radios can't reach each other at claimed range | Marketing "mile" ratings assume open, flat terrain with no obstructions — realistic range indoors/hilly/wooded is far less; get to higher ground or line of sight, or use a GMRS repeater. |
| GMRS repeater doesn't respond | You likely need the correct CTCSS/PL tone for that repeater, or you're transmitting on the output instead of the input (+5 MHz) frequency. |
| CB has lots of static/interference | Normal on 27 MHz, especially with electrical noise or "skip" during certain atmospheric conditions; try a different channel, or move away from electronics/power lines. |
| Ham handheld can't reach any repeater | You may be out of range/line-of-sight of any repeater — try the simplex calling frequency (146.520 / 446.000) directly, or get to higher ground. |
| Don't know the local ham repeater's frequency/tone | Check an offline-saved repeater directory (ARRL/RepeaterBook printout) before an emergency, or ask a local club — this can't be looked up without one. |
| Everyone in the group has a different radio type | Agree in advance on ONE shared license-free option (FRS or MURS) as the default family channel, even if some members also have GMRS/ham capability. |

# Quick-reference checklist
- [ ] Programmed/marked your **local NOAA Weather Radio frequency** (one of 162.400–162.550) and, if supported, your **county SAME code**.
- [ ] Agreed on a **family/group channel** in advance (FRS Ch 1 or a MURS channel are good license-free defaults) and written it down on paper.
- [ ] Obtained a **GMRS license** ($35, no test, 10 years, covers family) if you want repeater access and higher power.
- [ ] Know **CB Channel 9** (emergency, 27.065) and **Channel 19** (highway, 27.185) if you have a CB radio.
- [ ] If licensed, know the **2m (146.520 MHz)** and **70cm (446.000 MHz)** national simplex calling frequencies, plus your nearest repeater's output/input/tone.
- [ ] Know that **FRS/MURS/CB need no license**; **GMRS needs a license (no test)**; **ham needs a license and exam** — except in a genuine life-threatening emergency, when any means may be used.
- [ ] Have a **battery/hand-crank powered radio** that doesn't depend on the power grid or cell network.

# Sources
- **FCC 47 CFR Part 95 — Personal Radio Services** (FRS §95.563 et seq., GMRS Subpart E §95.1701–95.1815, MURS Subpart J §95.2763 et seq., CB Subpart D §95.401 et seq.): https://www.ecfr.gov/current/title-47/chapter-I/subchapter-D/part-95
- **FCC 47 CFR Part 97 — Amateur Radio Service** (including §97.403/§97.405, safety-of-life emergency provisions): https://www.ecfr.gov/current/title-47/chapter-I/subchapter-D/part-97
- **FCC — Family Radio Service (FRS):** https://www.fcc.gov/wireless/bureau-divisions/mobility-division/family-radio-service-frs
- **FCC — General Mobile Radio Service (GMRS):** https://www.fcc.gov/wireless/bureau-divisions/mobility-division/general-mobile-radio-service-gmrs
- **FCC — Multi-Use Radio Service (MURS):** https://www.fcc.gov/wireless/bureau-divisions/mobility-division/multi-use-radio-service-murs
- **FCC — Citizens Band Radio Service (CBRS):** https://www.fcc.gov/wireless/bureau-divisions/mobility-division/citizens-band-radio-service-cbrs
- **NOAA / National Weather Service — NOAA Weather Radio (NWR):** https://www.weather.gov/nwr
- **NWS — SKYWARN:** https://www.weather.gov/skywarn
- **ARRL — Band Plans:** http://www.arrl.org/band-plan
- **ARRL — Amateur Radio Emergency Service (ARES):** https://www.arrl.org/ares
- See also: [Communication](../topics/communication/communication.md) (broader family communication plan, alert systems, low-tech signaling), [Signaling for Rescue](../topics/signaling-rescue/signaling-rescue.md) (non-radio signaling methods), and [reference/local/INDEX.md](local/INDEX.md).
