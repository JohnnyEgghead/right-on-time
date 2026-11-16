# infra

What runs the app, on the hosted server `bw.j7l.io` and on an own copy. The section and decision numbers below (SPECIFICATIONS SD-3, 11.1 and so on) cite design documents that are not published.

| Path | What it is |
|---|---|
| `compose.yaml` | The 1 Compose file: `proxy`, `web`, `worker`, `pbs`, `db`, and `certbot` (hosted only, one-shot) |
| `image/Dockerfile` | The 1 app image (web, worker and pbs are 3 entry points of it); `plant` is the rollback drill's target |
| `nginx/` | `http.conf` (log format, upstream), site files `hosted.conf`, `local.conf`, `bootstrap.conf`, and `routes-locked.conf` / `routes-open.conf` |
| `placeholder/index.html` | The locked page, served by nginx while locked and by the skeleton web process |
| `profiles/demo.env` | The `demo` profile: the hosted demo's settings (SPECIFICATIONS 11.1) |
| `hosted/` | Hosted server only: `hosted.env` (site, lock, ports), `setup.sh`, `certbot-renew.sh` and its systemd timer, `bucket-check.sh` |
| `deploy/deploy.sh` | The deploy, started by hand from this Mac or Spectre |
| `deploy/server-deploy.sh` | Its server half (install, start, health wait, rollback) |
| `load/` | The load day on a temporary copy of the hosted plan (P4-LOAD, P7-LOAD): `temp-server.sh`, `run-day.sh`, the generated-world `fixture.sql` and `sessions.sql`; the script itself is `packages/testkit/src/load/`. `hosted-day.sh` (owner answer f3d84787) runs 1 day on the hosted server beside its stopped locked stack and restores it (`hosted-day.sh --help`), with `steal-watchdog.py` and `hosted-ports.py` |
| `ci-runner/`, `spike/`, `data/` | The CI runner image; throwaway spike stacks; spike S8 data notes |

## Deploy

From the repo root, on a clean tree:

```sh
bash infra/deploy/deploy.sh
```

1 command, no GitHub involved (owner ruling 64032d47, Oct 31, 2026: "Local script"). It reads the server's CPU architecture (amd64 today; the Mac is arm64), builds `bw-app:<commit>` for it, sends it with `docker save | ssh docker load` (skipped when the server already has that tag), copies the Compose file, nginx config, placeholder and hosted scripts to `/opt/brightwater`, runs `docker compose up -d`, and waits up to 120 s for `https://bw.j7l.io/healthz` to answer 200. If it does not, it starts the previous image and files again (the rollback). Re-running a deployed commit changes nothing and only re-checks `/healthz`.

- Log: `.build/deploy/<UTC stamp>-deploy.log` (gitignored).
- Exit 0: deployed, `/healthz` 200, and every other probed path answers as the staged routes say: the placeholder when locked, the app when open (F-1641). Anything else is non-zero.
- Access: `BW_HOST` (user@server-address, from the environment or the owner's private file; see `infra/drill/owner-env.sh`) with `~/.ssh/brightwater-lightsail.pem` (override with `BW_KEY`). The script stops with a message when the address is missing. The address is never in a committed file. The key never enters the repo.
- The server refuses the deploy while a spike stack is on it (BUILD_PLAN D-12).
- The small files (config, the env files, the map list, the image) travel through `/tmp/bw-deploy-stage` on the server; the map files never do (F-1646). Root owns it once the server half has run, so the script removes it with `sudo` before the copy and after the run. A stage left by an interrupted run is removed by the next one. If the closing removal fails, the log says so with a WARN on the last line.

- The map files (F-364): the deploy fetches and checks every file of `packages/maps/MANIFEST.json` here (the 3 branch maps, the track set, the routing files), stages their SHA-256 list and each file the server's record (`<map folder>/.verified.sha256`) does not hold yet; the server half checks each one, installs it where Compose mounts the map folder (`BW_MAPS_DIR`, default `/opt/.build/data/maps`, the `../.build/data/maps` beside `/opt/brightwater`), and refuses (exit 1) unless every listed file is there. The first deploy sends about 2.8 GB; a later one only a changed file.
- The map send (F-1646, F-1647, F-1648): the files go to `<map folder>/.incoming`, on the map folder's own disk, never the server's `/tmp` (on Debian 13 a RAM-backed tmpfs). Before the send the deploy reads that filesystem's free space and stops (exit 2) unless it holds the bytes to send plus 1 GiB; a failed send removes `.incoming`. The server half checks every sent file before it moves any, moves each in by a rename on that filesystem, and moves the routing sentinel `ohio.osrm.mldgr` last, so the routing service never starts on part of its set. Both halves and Compose read the map folder from 1 line: the `BW_MAPS_DIR` deploy.sh writes into the staged `env.base` (from `hosted.env` when set there, else the default).
- The backup timers (F-560): after setting them, the server half reads each timer back (`systemctl is-enabled`, `is-active`) into the log; a backup timer that reads enabled or active while the deploy asked it off fails the deploy (server exit 6).

The health wait: 200 passes. No answer, 502, 503 or 504 mean "not up yet", and the wait goes on to 120 s. Any other status (500, 404) is outside the section 7.4 contract, which answers only 200 or 503, so the rollback starts at once.

### The release deploy (F-1611, P8-UNLOCK)

```sh
bash infra/deploy/deploy.sh --release v1.0.0 --profile demo
```

It opens the demo: it stages `ROUTES=open` (F-1645), and its closing probe passes only when every probed path answers the app, not the placeholder. Put the owner's secrets in `/opt/brightwater/.env` (below the owner line) before it runs. It deploys `bw-app:v1.0.0`, the image `scripts/publish.sh image` built from the public tree, instead of building HEAD, so `PUBLIC_COMMIT` (the footer's Source link) names the public commit. It builds nothing. It refuses (exit 2) unless the publish state (`<clone>/.git/bw-publish/v1.0.0.env`; clone `BW_PUBLISH_CLONE`, default `.build/publish/right-on-time`) says the tag is pushed, the tag in that Docker context is still the checked image with `PUBLIC_COMMIT` and the revision label the public commit, for the server's architecture, and the files the deploy ships equal the release's private commit. After the load the server must hold that image with that `PUBLIC_COMMIT`. `--profile demo` needs `--release`: the open demo runs only the published image. A plain deploy keeps `PUBLIC_COMMIT=unknown`.

### Rollback drill

```sh
bash infra/deploy/deploy.sh --drill 500   # planted /healthz 500: rolled back at once
bash infra/deploy/deploy.sh --drill 503   # planted /healthz 503: rolled back after the 120 s wait
```

Each deploys a planted image whose `/healthz` answers that status. It passes when the server rolls back, `/healthz` answers 200, and the routes are still the ones the server ran before (read from its `.env`: locked before P8-UNLOCK, open after). It needs a healthy release on the server first.

## The lock

Until P8-UNLOCK the hosted server runs `ROUTES=locked`. nginx sends only `/healthz` to the web container and answers every other path with the placeholder page itself. The lock lives in nginx, not in the image, so no image deployed before release can open the demo. ROUTES comes from the deploy mode (F-1645), never from a file: `deploy.sh` stages exactly 1 `ROUTES` line, `open` only for `--release <tag> --profile demo`, `locked` for every other deploy and drill, and stops (exit 2) when `hosted.env` or `demo.env` holds one. P8-UNLOCK opens the demo with `bash infra/deploy/deploy.sh --release <tag> --profile demo` and no file change. A later plain deploy no longer locks the site silently (F-1660): `deploy.sh` reads the server's `ROUTES` on every deploy, and when it reads `open` and the deploy would stage `locked`, it stops (exit 2) before anything is built, copied or changed. Re-run with `--release <tag> --profile demo` to keep it open, or add `--lock` to lock it on purpose (`--lock` changes nothing else, and does not combine with `--drill`, `--profile` or `--host-files`). A server with no `ROUTES` line, or `ROUTES=locked`, deploys as before.

## Settings and the demo profile

Every setting of SPECIFICATIONS 11.1 that Compose sets is an interpolated variable whose default is the own-copy value, so a plain `docker compose up` is "all off". The hosted demo's values are `profiles/demo.env`; `deploy.sh --profile demo` adds them to the server's `.env`. A Compose `profiles:` entry can only add or drop services, never change a setting, so the demo profile is a settings file. Secrets never go in it; on the server the postgres password stays in `/etc/brightwater/db.env` (root, mode 600).

On the server, `/opt/brightwater/.env` holds `hosted.env`, the profile when asked, and `BW_IMAGE`, so every plain `docker compose` there (the certbot timer too) sees the same values. Those are the deploy's keys, rewritten by every deploy and named on the file's first line (`# deploy-owned keys: ...`). Every other `KEY=value` line already in that file (the owner's: secrets, `IOS_INSTALL_KIND`, `IOS_INSTALL_LINK`) is kept, byte for byte, below them on every deploy (F-98); the deploy log names the kept keys, never a value. A key the last deploy owned and this one does not (the demo profile not asked) is dropped. `ROUTES` and `BW_MAPS_DIR` are the deploy's keys too: an owner line for either is not carried. F-1649: no owner line is dropped without a log line naming its key (or, for a line that is no `KEY=value`, its line number), never its value; `export` prefixes, spaces around `=` and multi-line quoted values are read as Compose reads them. `/opt/brightwater/.prev/` holds the previous release's files.

## Logging (SPECIFICATIONS 11.4)

nginx writes 1 JSON line per request: time, method, mapped URI, status, bytes, duration. The URI is `$request_uri` without its query string, with the token segment of `/m/`, `/r/`, `/inbox/`, `/email/`, `/set-password/` and `/book/done/` replaced by `:token`. The access log holds no client address, Referer or user agent. nginx's error log is the proxy's other log: at its default level it writes the raw request line (token and query string included), the client address and the host on every upstream error, so `http.conf` holds it at `crit` for every request (F-97). A request that fails upstream then shows only as its access line (status 502 or 504, mapped URI). Lines at `crit` and above are still written for faults such as an unreadable file or a worker that dies, and such a line can carry the client address and the request line; start-up and reload messages carry neither. Read it with `sudo docker compose -f /opt/brightwater/compose.yaml logs proxy`.

## Setting up the world (P2-SETUP)

Setup writes the sample world once, on a fresh database: the 6 steps of BUILD_PLAN section 3 D-3 (reference seed, generator, import dry run, real import, world seed, snapshot), as the schema owner. It needs `SAMPLE_PASSWORD_SEED` (16+ characters) and the verified street list (`node ci/data-assets.ts ensure` puts it in `.build/data`).

- First, on the host: `pnpm run setup:maps` downloads the map files and checks them against `packages/maps/MANIFEST.json` into `.build/data/maps` (`BW_MAPS_DIR` points Compose at another folder). In the stack, setup checks them again and stops, named, on a missing or wrong file.
- In the stack: `docker compose --profile setup run --rm setup` (the image's `packages/setup`; the street list is mounted read-only from `BW_DATA_DIR`, default the tree's `.build/data`).
- From a checkout: `pnpm run setup` with `DATABASE_URL` set to the owner (bare `pnpm setup` is pnpm's own built-in command).

It stops with 1 JSON log line, status `setup refused` with the stop's code in `errorCode`, on a world that is not fresh, while an office import run is marked running, or when a fixture customer does not resolve to exactly 1 customer; recreate the database to run it again.

### Resetting a set-up world (F-1801)

A world that finished setup never takes changed sample rows: setup stops on it (`world_not_fresh`), and the nightly reset refills the world from its own snapshot. To give it the current sample data, `bash infra/deploy/reset-world.sh` (run by hand from this Mac, like `deploy.sh`; the server from `BW_HOST`) stops `web`, `worker` and `pbs`, removes the `db` service and its database volume, starts `db` again, runs `migrate`, runs setup with the sample password seed of the server's own `.env` (so the same accounts and sign-ins come back), and starts the services; then run `infra/backup/hosted-check.sh`. Visitor changes go, as at every nightly reset; alert and health history starts over; the demo is offline while setup runs. It changes no setting in the `.env`, and photo files no row names go at the worker's hourly cleanup. Each step is printed; the log is `.build/deploy/<UTC stamp>-reset.log`; exit 0 only on success, and a re-run after a failed step starts again at its checks. On the hosted demo it runs at P8-B9-RELEASE, as 1 owner grant (owner answer 5d88f9a6). `--local [--project <name>] [--env-file <file>]` runs the same steps on a local stack started from `infra/compose.yaml`.

A world set up before migration 0020 (an own copy or the hosted demo set up before that migration shipped) shows no old customer numbers on the customer page (SCR-OFC-14), and its reset keeps them empty (F-890). 0020 adds `customer.old_customer_number` with no backfill: only an import writes it, and the reset restores the world's own snapshot, taken before the column existed. The data is otherwise sound. To show the old numbers, recreate the database and set up again, from the repo root: `docker compose --env-file .env -f infra/compose.yaml down`, `docker volume rm brightwater_pgdata`, `docker compose --env-file .env -f infra/compose.yaml up -d --wait` (migrate runs first), then `docker compose --env-file .env -f infra/compose.yaml --profile setup run --rm setup`. This discards every change made in that world. On the hosted server, run the same commands with `sudo` and `-f /opt/brightwater/compose.yaml`.

An own copy's database password is the published default in `own-copy-db.env` (F-96); the hosted server's `/etc/brightwater/db.env` overrides it.

Every start runs the `migrate` one-shot first, as the schema owner: it applies the pending migrations, then sets the password of each process login (`bw_web`, `bw_worker`, `bw_pbs`) from that process's password file in its own volume (`dblogin-web`, `dblogin-worker`, `dblogin-pbs`), written once, when absent. `web`, `worker` and `pbs` start only after it completes, each reading only its own file (`DATABASE_PASSWORD_FILE`; SPECIFICATIONS SD-3).

## Office import runs (P3-IMPORT-WORKER)

API-80 (dry run) and API-84 (real run) only request a run; the worker's import job executes it (`apps/worker/src/import`), at start-up and whenever a request waits. It reads no export folder: like setup, it makes the generator's checked export in process from the street list mounted at `/app/.build/data` (`BW_DATA_DIR`, as for setup) and refuses any byte that differs from `packages/generator/MANIFEST.json` (the run ends failed, `generator_manifest`). A run whose worker dies is executed again when the worker restarts, 3 attempts in all, then it ends failed (`attempts_exhausted`). The job runs no import while setup runs; the worker's cap is setup's (768m) because it does the same work.

- The deploy stages the verified street list and installs it where Compose mounts it from (default `../.build/data` beside `/opt/brightwater`), then runs `node apps/worker/src/import/check.ts` in the worker: `IMPORT SOURCE OK` in the log, or exit 5.
- The stack proof: `bash ci/import-stack.sh` (about 10 minutes; needs docker).

## A fresh server

Not needed today; the live server was set up by spike S5. On a new one: copy `compose.yaml`, `nginx/`, `placeholder/` and the `hosted/` files to `/opt/brightwater`, run `sudo bash setup.sh` there (Docker, the postgres password, the first certificate, the renewal timer), then run `bash infra/deploy/deploy.sh` from here. This path has not been re-run since P1-DEPLOY changed `setup.sh`.

## Known limits of the skeleton

- `/healthz` answers 200 while the database answers and the worker heartbeat (`system.worker_heartbeat`, written every 10 s by the worker, P3-ALERTS) is under 60 s old; otherwise it answers 503, including when the database does not answer, never 500.
- `worker` and `pbs` only start and wait. Their real code replaces them.
- The event stream route `/api/v1/events` (API-09) is built: `packages/api-server/src/events` (the bus and the stream handler), served by the web process through the kernel (a contract row with a policy entry, F-344), configured in `routes-open.conf` (from spike S1).
- Finding F-61 (a browser sends `Accept-Encoding`, and compression can buffer a stream): the app side is met. The stream is answered by the kernel path, which never passes through Next.js (so Next's gzip never applies), with `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`; nginx has gzip off (the image default, and `gzip off` on the events location). The load run with browser headers stays with F-61's testkit deferral.
- SPECIFICATIONS 11.1 names `/opt/brightwater/.env` for the hosted secrets, matching the live server's S5 layout (`/opt/brightwater`, `/etc/brightwater/db.env`). P8-UNLOCK places its secrets.
