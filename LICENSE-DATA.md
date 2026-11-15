# Data license

The map files, the baked tracks and the street list of Right On Time are made from OpenStreetMap data. They are published under the Open Database License (ODbL) 1.0: <https://opendatacommons.org/licenses/odbl/1-0/>.

## Attribution

Contains information from OpenStreetMap, which is made available under the Open Database License (ODbL).

**© OpenStreetMap contributors.** The copyright and license page is <https://www.openstreetmap.org/copyright>.

The app shows "© OpenStreetMap" on every map, linked to that page. Keep that credit when you copy, change or share these files or anything made from them.

## What this license covers

| Data | Where it is | Made from |
|---|---|---|
| Map files | 3 PMTiles files, one for each branch area (`packages/maps/MANIFEST.json`) | OpenStreetMap, through a Protomaps build |
| Baked tracks and routing files | The track set and the routing files of the same run (`packages/maps/MANIFEST.json`) | The same map data, run through OSRM |
| Street list | `street-list.json` (`node ci/data-assets.ts ensure` downloads it and checks it) | Real street names and on-street points from OpenStreetMap |

These files are release downloads. They are not in git. `pnpm run setup:maps` and `node ci/data-assets.ts ensure` fetch them and check each one against its recorded SHA-256.

## What it does not cover

The ODbL covers the data files above. The program code is under the AGPL-3.0-or-later license (`LICENSE`), with the App Store permission in `COPYING.iOS`.

The sample world is made up: the company, the people, the phone numbers and the house numbers are fictional. Only the street names and the street points come from OpenStreetMap.
