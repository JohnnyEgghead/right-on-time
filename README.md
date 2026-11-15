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

2. Download the map files and the street list from their GitHub releases, and check them:

   ```sh
   node ci/data-assets.ts ensure
   pnpm run setup:maps
   ```

3. Write the sample world once, on a fresh database, then start the app:

   ```sh
   docker compose --env-file .env -f infra/compose.yaml --profile setup run --rm setup
   docker compose --env-file .env -f infra/compose.yaml up -d
   ```

4. Open <http://localhost:8080>.

`infra/README.md` has the details: what each service does, the settings, and how to start over.

### Settings beside demo mode

Every setting is an environment variable with an own-copy default. These 2 sit side by side, because both change what the sign-in pages allow (the design documents, which are not published, call this section 11.1):

| Setting | Own copy default | Hosted demo | What it does |
|---|---|---|---|
| `DEMO_MODE` | `off` | `on` | Demo mode: the web sign-in page offers a "Sign in as" list of the sample people, with an on-screen marker. |
| `RESET_PROTECTION` | `off` | `on` | Reset protection: with it `on`, Forgot password answers "not sent" for every address. With demo mode on, a sample person is refused whatever this setting says, so the password the start page lists keeps working. With it `off` (your copy), a staff member who forgot a password resets it from the on-screen email inbox. |

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
pnpm run lint
pnpm run typecheck
pnpm run test
```

`pnpm run setup` writes the sample world into a database. It needs `DATABASE_URL` (the schema owner) and `SAMPLE_PASSWORD_SEED` set in your shell. Bare `pnpm setup` is pnpm's own command, so type `pnpm run setup`.

| Folder | What it is |
|---|---|
| `apps/web` | The web app: office, technician and customer pages |
| `apps/tech-native` | The native iPhone technician app |
| `apps/worker`, `apps/pbs` | The background worker and the pretend billing service |
| `packages/` | Shared code: domain rules, database, API, import, maps, text messages |
| `infra/` | Compose file, nginx, the image, deploy scripts |
| `ci/` | The checks that run before a change merges |
