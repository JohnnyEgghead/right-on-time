# Third-party notices

Right On Time is made with other people's work. This file is the credit list that ships with the source and with the release image (at `/app/THIRD-PARTY-NOTICES.md`).

## Credits a license requires

These are the credits the license of a shipped part asks for, word for word as the license check records them (`ci/license/policy.json`):

- caniuse-lite: browser support data from caniuse.com (Fyrd/caniuse), packaged by the browserslist project (https://github.com/browserslist/caniuse-lite), licensed CC-BY-4.0 (https://creativecommons.org/licenses/by/4.0/).

## Map and street data

The map files, the baked tracks, the routing files and the street list are made from OpenStreetMap data, © OpenStreetMap contributors, under the Open Database License (ODbL) 1.0. See `LICENSE-DATA.md`.

## Packages

The app is built from open source npm packages. Each package's own license file is inside its folder under `node_modules` (in the release image, under `/app/node_modules`). `pnpm-lock.yaml` lists every package and version. The license check (`ci/license/policy.json`) names the licenses a shipped package may have.

## Programs the hosted setup runs beside the app

These run as their own upstream container images. They are not part of the app image:

- OSRM backend (the routing service), BSD-2-Clause. The license text is `ci/license/osrm-backend-v26.10.0-LICENSE.TXT`.
- Certbot (certificate renewal), Apache-2.0. The license text is `ci/license/certbot-v5.8.0-LICENSE.txt`.
- PostgreSQL, nginx and Node.js, each under its own license, from their official images (`infra/compose.yaml` and `infra/image/Dockerfile` pin them).

## The app's own license

The program code is under the GNU Affero General Public License, version 3 or later (`LICENSE`), with the App Store permission in `COPYING.iOS`.
