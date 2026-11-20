# Right On Time (Brightwater Heating & Air)

A scheduling and dispatch app for a heating, cooling and plumbing service company:

- online booking in 2-hour arrival windows;
- a dispatch board;
- a technician phone app (an iPhone app and a web app);
- customer text messages with a live map;
- manager reports;
- a billing link;
- an import of the old system's data.

Brightwater Heating & Air and its people are fictional. This is a demo.

## License

- The program code is under the **GNU Affero General Public License, version 3 or any later version** (`LICENSE`). Every source file carries the line `SPDX-License-Identifier: AGPL-3.0-or-later`.
- `COPYING.iOS` gives the App Store permission for the native iPhone app (AGPL section 7).
- The map files, tracks and street list come from OpenStreetMap and are under the ODbL (`LICENSE-DATA.md`). Credit: © OpenStreetMap contributors.

Outside code contributions are not accepted for now. Bug reports are welcome.

## Run your own copy

You need Docker (or Podman or Colima, see below) with Compose, plus Node 26.12.1 and pnpm 12.14.0 for the download step 2. The download needs no login and no token: it uses the public release URL. The GitHub CLI (`gh`) or a `GITHUB_TOKEN` (or `GH_TOKEN`) is used only when you have one, for a private release. A copy runs from the one Compose file, `infra/compose.yaml`.

1. Copy the settings file. It holds the published sample password seed:

   ```sh
   cp .env.example .env
   ```

   Then add this line to `.env` to get the "Sign in as" list of the sample people on the sign-in page (without it, `DEMO_MODE` is `off` and the page asks for an email and a password):

   ```sh
   DEMO_MODE=on
   ```

2. Download the map files and the street list from their GitHub releases, and check them. This is about 2.8 GB, so allow time and disk space: 2.7 GB of it is the routing service's files, which `pnpm run setup:maps` fetches.

   ```sh
   node ci/data-assets.ts ensure
   pnpm run setup:maps
   ```

3. Write the sample world once, on a fresh database, then start the app:

   ```sh
   docker compose --env-file .env -f infra/compose.yaml --profile setup run --rm setup
   docker compose --env-file .env -f infra/compose.yaml up -d
   ```

4. Open <http://localhost:8080>. The start page has 3 doors. Choose Sign in under Office and managers. With `DEMO_MODE=on`, the sign-in page has a "Sign in as" list of sample people: pick Dana Ruiz (the manager) and the dispatch board opens. Picking a technician opens the technician web app at `/tech`, not the board. With demo mode off, there is no list: choose Forgot password and type `dana.ruiz@brightwater.example`. Your copy shows the reset email in its on-screen email inbox, and the link in it sets a new password.

A copy listens on `127.0.0.1:8080` only (`HTTP_BIND`), so only the computer it runs on can open it. To open it from another device, set `HTTP_BIND` (for example `0.0.0.0:8080`) and an `APP_ORIGIN` that matches the address you type in that device's browser (for example `http://192.168.1.20:8080`) in `.env`, then run the `up -d` line again. With `DEMO_MODE=on`, anyone who can reach your copy can sign in as any sample person, the manager included, with no password. Do that only on a network only you use. Before you open your copy, do both of these. First, change `SAMPLE_PASSWORD_SEED` before the first setup, because the published seed and the code that works the passwords out are public, and with them anyone can sign in as the manager. Second, turn the access code on (`ACCESS_CODE_ON=on`, with an `ACCESS_CODE` of 6 or more characters and an `ACCESS_COOKIE_KEY` of 32 or more), because it stops "Sign in as" and Forgot password for anyone who does not have the code.

`infra/README.md` has the details: what each service does, the settings table (every setting, its own-copy default and what it does), and how to start over.

An own copy resets itself to its starting state after 120 minutes with no change, and every change visitors made goes with it. To turn that off, set `IDLE_RESET_MINUTES=0` in `.env`. The nightly reset at 3:00 AM Eastern is the hosted demo's: it is off on your copy (`NIGHTLY_RESET=off`).

### Settings beside demo mode

Every setting is an environment variable with an own-copy default; the settings table in `infra/README.md` lists them all. These 2 sit side by side, because both change what the sign-in pages allow:

| Setting | Own copy default | Hosted demo | What it does |
|---|---|---|---|
| `DEMO_MODE` | `off` | `on` | Demo mode: the web sign-in page offers a "Sign in as" list of the sample people, with an on-screen marker. |
| `RESET_PROTECTION` | `off` | `on` | Reset protection: with it `on`, Forgot password answers "not sent" for every address. With demo mode on, Forgot password is refused for a sample person whatever this setting says. With it `off` (your copy), a staff member who forgot a password resets it from the on-screen email inbox. So with it `off`, anyone who can reach the sign-in page can reset any staff password, a manager's included. This applies once your copy can be reached from another device (see `HTTP_BIND` above): until then only the computer it runs on can reach it. Keep a copy that other devices can reach on a network only you use. |

The hosted demo turns reset protection on so that a visitor cannot lock the sample people out. Your own copy leaves it off.

### Docker Desktop terms

Docker Desktop is free for personal use, for non-commercial open source, and for businesses with fewer than 250 employees and less than $10M in revenue. A larger business needs a paid Docker subscription. You do not need Docker Desktop: **Podman** (Apache-2.0) and **Colima** (MIT) are free engines that run the same Compose file. With Colima, start it with `colima start`, then use the `docker compose` commands above. With Podman, use `podman compose` in place of `docker compose`.

## The sample data is made up

- The sample addresses are fictional. Each one uses a real street name with a made-up house number, so the number points at no real home.
- The sample phone numbers are reserved fictional numbers (555-0100 to 555-0199). Only 200 numbers exist (100 in each of the 2 area codes, (614) and (937)), so sample phone numbers repeat across customers. The import never matches duplicate customers on a phone number alone.
- Every sample person's password comes from `SAMPLE_PASSWORD_SEED` in `.env` (16 or more characters). The value in `.env.example` is published on purpose and is not a secret. Do not use it on a copy that holds real data.

## Developer path

You need Node 26.12.1 (`.node-version`), pnpm 12.14.0 (the `packageManager` field of `package.json`) and PostgreSQL 18.

```sh
pnpm install --frozen-lockfile
node ci/data-assets.ts ensure
pnpm run lint
pnpm run typecheck
pnpm run test
```

The `ensure` line fetches the street list (setup step 2) once: some tests read it.

`pnpm run setup` writes the sample world into a database. It needs `DATABASE_URL` (the schema owner) and `SAMPLE_PASSWORD_SEED` set in your shell. Bare `pnpm setup` is pnpm's own command, so type `pnpm run setup`.

| Folder | What it is |
|---|---|
| `apps/web` | The web app: office, technician and customer pages |
| `apps/tech-native` | The native iPhone technician app |
| `apps/worker`, `apps/pbs` | The background worker and the pretend billing service |
| `packages/` | Shared code: domain rules, database, API, import, maps, text messages |
| `infra/` | Compose file, nginx, the image, deploy scripts |
| `ci/` | The checks that run before a change merges |

Some comments and test notes in the code name paths under `docs/build/`, `.build/evidence/`, `mockups/` and `docs/UI-SPECIFICATION.md`. Those are the maintainer's private build records and design files. They are not part of this repository, so those paths do not exist here and need no action from you. A test that reads one of them skips here, and its skip note names the missing path.
