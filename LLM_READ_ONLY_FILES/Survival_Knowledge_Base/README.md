# Survival Knowledge Base — Offline Emergency & Survival Reference

A comprehensive, **fully offline** emergency and survival reference, written for two readers:
1. **A person** — even a complete beginner — who can open and read these files directly, no internet or power needed.
2. **A local AI (LLM)** running offline, which reads these files to answer a person's survival questions in a real emergency.

Everything here is **plain Markdown (`.md`) and PDF** — formats a human can open in any text viewer, and an LLM can read directly. No internet is ever required to use it.

> ⚠️ **Important disclaimer.** This is educational reference material for emergencies when **no professional help is available.** It is **not** a substitute for a doctor, a trained first responder, or official guidance. When real emergency services or medical professionals can be reached, **contact them first.** Some techniques carry risk; read the safety warnings in each guide. Verify anything critical against the included manuals.

---

## How the collection is organized

```
Survival_Knowledge_Base/
├── START-HERE.md      ← ⭐ read FIRST in an emergency: life-threat triage + situation→guide router
├── README.md          ← you are here (how to use the set)
├── INDEX.md           ← master index: every topic → its file, with a one-line summary
├── COVERAGE.md        ← honest status tracker (what's complete / partial / planned)
├── GLOSSARY.md        ← plain-language definitions of terms used across the guides
├── CHECKLISTS.md      ← printable master appendix: starter + per-guide checklists
├── topics/            ← the guides, one folder per topic
│   ├── water/water.md
│   ├── fire/fire.md
│   ├── shelter/shelter.md
│   ├── first-aid/first-aid.md
│   └── ... (one deep guide per major survival topic) ...
│   └── <topic>/images/   ← images referenced by that topic's guide
└── reference/
    ├── manuals/       ← full public-domain field manuals (PDF) for depth
    │   └── INDEX.md      ← what each manual is and which topics it supports
    ├── maps/          ← offline road/highway/street maps (PDF) for no-GPS navigation
    │   └── INDEX.md      ← national + all 50 states + street-level North Texas
    ├── local/         ← local emergency data (numbers, frequencies, hospitals) — all 50 states (deep: TX/OK/AR)
    │   └── INDEX.md
    └── comms-frequencies.md  ← radio channel/frequency card (NWR, FRS/GMRS, MURS, CB, ham)
```

**Every topic guide is self-contained** and follows the same structure, so any single guide (or even a single section of one) makes sense on its own:
- **Read this first** — the 30-second version (most critical actions).
- **Why this matters**, **Key terms** (jargon defined for beginners).
- **What you need** — materials, with improvised substitutes.
- **Step-by-step methods** — multiple ways to solve each problem, with exact quantities, times, and how to tell it worked.
- **Regional & scenario variants** (including North Texas notes), **Safety warnings**, **Troubleshooting**, a **Quick-reference checklist**, and **Sources**.

## How to use it — as a person
1. Open **`INDEX.md`** and find your topic (water, fire, first aid, …).
2. Open that topic's `.md` file. Start with its **"Read this first"** section for the fastest answer, then read on for full detail.
3. For maximum depth (or to double-check), open the related PDF manuals in **`reference/manuals/`**.

## How to use it — with a local, offline LLM
This set is built to be a **knowledge base for an offline AI assistant** (for example, a local model with retrieval/RAG over these files). Point your offline LLM at this folder, then **ask it plain-language questions** — it will pull the relevant guide(s) and walk you through the steps.

**Example (the scenario this set is designed to pass):**
> **You ask the offline LLM:** *"I have no power, living in a small town in north Texas called Anna, and I need to know how to find water and make it drinkable."*
>
> **The LLM finds** `topics/water/water.md` and `topics/regional-north-texas/regional-north-texas.md`, and answers with: where to find water near Anna (your water heater tank and toilet *tank* first; then rain, then the region's abundant stock ponds and creeks); how to judge if a source is usable; and **several** complete, step-by-step ways to make it safe to drink (boiling, household-bleach dosing, a DIY sand/charcoal filter, solar disinfection, distillation) — with exact amounts, times, and safety warnings.

**Tips for asking the LLM:**
- Describe your **situation and location** ("no power, rural, cold night, I have a lighter and a metal pot").
- Ask for **step-by-step** instructions and say you're a **beginner** ("explain it like I've never done this").
- Ask for **more than one method** ("what are other ways if I can't make a fire?").
- Ask **follow-ups** — the guides are detailed, so the LLM can drill in.

## Topics covered
**49 deep guides.** Core survival: Water · Fire · Shelter · Food (foraging & wild edibles; hunting, fishing & trapping; preservation & cooking without power; growing; raising livestock; long-duration nutrition) · First aid · Emergency medicine & herbal remedies · Navigation without GPS · Signaling & rescue · Sanitation & hygiene · Communication without internet · Emergency power & energy · Security & home defense · Weather prediction · Psychological first aid · Emergency childbirth & care of vulnerable people · Tools, knots & repairs · Disaster-specific guides · North Texas regional guide.

Planning, home & prolonged-emergency operations: Emergency planning, triage & decision-making · Evacuation, bug-out & vehicle survival · Transportation & vehicle emergencies · Emergency supplies, inventory & rotation · Survival logistics & resource management · Documents, money & emergency administration · Children & family emergency operations · Structural, utility & household emergencies · Electrical, gas & utility safety · Water, flooding & plumbing emergencies · Home & structural assessment after a disaster · Recovery & rebuilding · Fire, smoke & hazardous-air emergencies · Hazardous materials & contamination · Extreme heat & extreme cold survival (incl. sunburn & frostbite) · Clothing, footwear & personal protection · Animal, insect & pest hazards · Community survival & mutual aid · Bartering, trade & resource exchange · Death, human remains & bereavement in prolonged emergencies.

Self-sufficiency & homestead skills: Tools, knots & repairs · Basic metalwork & tool-making · Making soap & hygiene supplies · Emergency lighting (candles & oil lamps) · Textiles & making/mending clothing · Dairy processing (butter, cheese, yogurt) · Beekeeping.

Plus **quick-access appendices** at the root: **START-HERE.md** (emergency triage & router), **GLOSSARY.md** (472 terms), and **CHECKLISTS.md** (master checklist).

See **`INDEX.md`** for the full list with descriptions and **`COVERAGE.md`** for the current status of each.

## About the reference manuals
`reference/manuals/` holds 57 full public-domain / openly-available field manuals (US Army FM 21-76, American Red Cross, FEMA "Are You Ready", FEMA P-234, CDC, EPA, USFA, CPSC, OSHA, NOAA/NWS, WHO/PAHO, wilderness first aid, edible-plant field guides, and more). The Markdown guides summarize and cross-reference these, so the LLM can answer from the text directly — the PDFs are there for extra depth and for a human who wants the original source. See `reference/manuals/INDEX.md`.

## About the offline maps
`reference/maps/` holds public-domain road and street maps for navigating **without internet or GPS**: a nationwide tier (US highway/interstate maps), a state tier (a highway map for **all 50 states**), and **street-level** USGS topographic quads for the Anna / Collin County / North Texas home region. See `reference/maps/INDEX.md` for coverage and how to use them (and its note on why whole-country street-level maps need an offline map app rather than static files). Use them with the [Navigation Without GPS](topics/navigation/navigation.md) guide.
