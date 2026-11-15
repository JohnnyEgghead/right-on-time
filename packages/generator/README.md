# @bw/generator

Writes the old system's export and the world seed's fixture from 1 seeded PRNG (xoshiro128** with seed 20260915).
It follows SPECIFICATIONS section 6.7, SD-24 and SD-25, and BUILD_PLAN D-3 step 2.
It writes no database row. The world seed writes the `pilot_call` rows later (D-3 step 5).

**Sample data is fictional.** The sample addresses are fictional: each street name is a real street from the bundled
street list (OpenStreetMap, ODbL; city and ZIP from US Census TIGER/Line), and every house number is made up by the
seeded generator (OA-41). Sample phone numbers are reserved fictional numbers, (614) or (937) 555-0100 to 555-0199, so
they repeat across customers (FR-IMP-7). The business and its people are fictional.

## Commands

Run from the repo root. The street list must be in `.build/data` first (`node ci/data-assets.ts ensure`).

| Command | Does |
|---|---|
| `node packages/generator/src/cli.ts generate [--out <dir>]` | Writes the 5 files to `.build/data/generator` (git-ignored, D7) |
| `node packages/generator/src/cli.ts write-manifest` | Regenerates and rewrites `MANIFEST.json` and `truth.json` (after an intended change) |
| `node packages/generator/src/cli.ts generator-manifest [--dir <dir>]` | FR-IMP-5: every file's SHA-256 and size equal `MANIFEST.json` |
| `node packages/generator/src/cli.ts phone-range-scan [--dir <dir>]` | FR-IMP-7: no other 555 or real-looking number |
| `node packages/generator/src/cli.ts share-none [--dir <dir>]` | R-BP1: no fixture customer is in a truth pair; each resolves to exactly 1 row |
| `node packages/generator/src/cli.ts truth-check [--dir <dir>]` | FR-IMP-3, FR-IMP-6: the truth file equals customers.csv and the committed file |
| `node packages/generator/src/cli.ts target-counts [--dir <dir>]` | FR-IMP-6: every problem-row count of the target table |
| `node packages/generator/src/cli.ts rates [--dir <dir>]` | SD-25: the before and after pilot rates and the Sep 8 to 14 rate |

The gate `generator-gates` (`ci/gates/generator-gates.sh`) runs 2 generations, compares them byte for byte, then runs every check.

## The sample-day script

`fixture.json` holds each scripted visit's minutes (On my way lead, arrival delay, work). The step times need drive minutes, and those need the baked tracks, so the world seed computes them in setup step 5: `src/chain.ts` chains each visit on SD-15's plan (owner answer 36d87aec). A step never starts before the visit ahead of it ends.

## Committed files

- `MANIFEST.json`: the SHA-256 and size of the 5 generated files. The files themselves are never committed (D7).
- `truth.json`: the planted-truth file (FR-IMP-3: "the committed planted-truth file"): 812 exact and 428 likely pairs by `customer_ref`; `a` is record A, the row that comes first in `customers.csv` (OI-50).
- `named-people.json`: the named sample people of FR-IMP-9, placed before the PRNG fills the rest.
- `technicians.json`: the technician roster the visits and the fixture name (employee numbers from 40701; Maria Santos 40712). The reference seed (P2-SEED) seeds this roster.

## File layouts (the import's fixed column layout)

All CSV files: UTF-8, a header row, `\n` line ends, RFC 4180 quoting, 1 fixed row order (OI-51): ascending ref.
Dates are `YYYY-MM-DD` and times `HH:MM`, local wall clock in the branch zone (America/New_York).

`customers.csv`: `customer_ref, name, mobile, home_phone, email, street, house_number, city, zip, text_language, time_zone, texts_on, customer_since, home_type, getting_in, exported_at`.
`texts_on` is `yes` or `no`; `exported_at` is `2026-08-31T05:00:00-04:00` on every row (SD-24); an empty `home_type` stays null.
The street is resolved by `street`, `city` and `zip`; a row with no ZIP (a planted problem row) by `street` and `city`, which the list holds once.
The address's point is the street's `points[(house_number - 1) mod point count]` (SD-23).

`visits.csv`: `visit_ref, customer_ref, date, window_start, window_end, arrived_at, outcome, technician, service, work_done`.
`outcome` is `done` or `no_one_home` (empty `arrived_at`); `visit_ref` is the row reference for `past_visit.source_ref`.
Before Mon, Jul 20, 2026 windows are the old way's 4 hours; from Jul 20 the pilot's 2 hours.

`equipment.csv`: `equipment_ref, customer_ref, street, house_number, city, zip, type, year, location, details`.
`type` is 1 of section 3's equipment types. An equipment row with all 4 address cells empty is a planted problem row.

Planted problem rows (FR-IMP-6): a visit whose `customer_ref` is in no customer row (418); a customer with an empty
`zip` (214); a `mobile` with too few digits (187); a visit `date` that is not a real `YYYY-MM-DD` date (124); an
equipment row with no address (154); a customer with an empty `name` (87). Each problem row has exactly 1 reason.

## Blocking

The truth file is the whole duplicate set: the generator keeps every blocking block of 2 or more customers to
exactly 1 planted pair. Its model of section 6.7's blocking keys: each token of the folded last name plus the ZIP cell,
and the folded first name plus the street. The name's first token is the first name and the rest is the last name, so
"Kathleen O'Brien-Miller" and "Kathy OBrien" share the block `obrien` + 43221. The fold is `foldStreetName` of @bw/db.

## The fixture (`fixture.json`)

1 array element per line. `customers` lists every customer the fixture names, by `ref` (= `customer_ref`), with the
import's exact-match key the world seed resolves (`nameSearch`, `street`, `city`, `zip`, `houseNumber`; R-BP1). None is
flagged, a named person (except where placed on purpose) or in a truth pair. Arrays:

- `pilotJobs`: ended jobs Mon, Aug 31 to Mon, Sep 14, 2026 (`done` or `no_one_home`), job numbers below 24800.
- `pilotCalls`: simulated "where is my tech" calls, each naming the visit asked about by `visitRef` or `jobNumber`.
- `demoWeekJobs`: scheduled jobs Tue, Sep 15 to Mon, Sep 21, from job number 24800; Harold Jenkins is 24830 with Maria Santos, 10 AM-12 PM.
- `memberships`: Comfort Club memberships (`benefitsKey` `comfort_club`).
- `sampleDayScript`: SD-21's autopilot steps per demo-week job, except Maria Santos's jobs on Sep 15 from 10 AM on.

Service ids: `furnace_tune_up`, `ac_tune_up`, `heating_or_ac_fix`, `plumbing_repair`, `water_heater`, `thermostat`,
`boiler_repair`, `tankless_heater_flush`, `sump_pump_install` (SD-20's 9 services, in its order).

Every fixture job's service is one its technician's skills cover (F-1666; the skills are the reference seed's technician plan).
A drawn service a technician lacks the skill for becomes the service of the same minutes that the skills cover, with no PRNG
draw, so the plans and script rows stay as drawn. Rosa Delgado's Sep 15 job (24826, Marcus Bell, a plumber) is a
`plumbing_repair` with the problem "Sump pump install", its visit's work drawn on the install's minutes.
