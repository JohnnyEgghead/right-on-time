# CI runners (SPECIFICATIONS SD-38)

2 GitHub Actions self-hosted runners, registered to the private repo JohnnyEgghead/Brightwater only.
Never register them to the public repo right-on-time. CI never uses a GitHub-hosted runner
(`ci/no-hosted-runners.ts` enforces it).

| Runner | Labels a job uses | Where | Form |
|---|---|---|---|
| `linux` | `[self-hosted, linux]` | Spectre's Docker Desktop | this Compose stack: runner container plus its own Docker-in-Docker engine |
| `mac` | `[self-hosted, mac]` | the owner's Mac | native runner in `~/actions-runner-brightwater`, run as the user (no sudo) |

## linux runner (from the Mac, through the `spectre` context: management only)

First registration (the token lasts 1 hour and is never committed or printed):

```sh
cd infra/ci-runner
umask 077
gh api -X POST repos/JohnnyEgghead/Brightwater/actions/runners/registration-token \
  --jq '"RUNNER_TOKEN=" + .token' > .env          # .env is gitignored
docker --context spectre compose up -d --build
printf 'RUNNER_TOKEN=\n' > .env                     # blank it once the runner is registered
```

The registration is saved in the `runner-state` volume, so later starts need no token:
`docker --context spectre compose up -d`. Status: `docker --context spectre compose ps` and
`gh api repos/JohnnyEgghead/Brightwater/actions/runners`.

Stop: `docker --context spectre compose stop`. Remove everything (also unregister the runner in
GitHub settings): `docker --context spectre compose down -v`.

The engine is the `dind` service. Jobs never see Docker Desktop's socket. Its images and volumes
live in `dind-storage`, apart from every other stack on Spectre. The runner and the engine share
`/home/runner/_work` at the same path, and the runner's externals are copied to a volume the engine
mounts at `/home/runner/externals`, so `container:` and `services:` jobs resolve their mounts.

If Spectre is off, asleep or Docker Desktop is not running, Linux jobs wait in the queue. That is
expected (BUILD_PLAN D-8): never move the job elsewhere.

## mac runner

```sh
mkdir -p ~/actions-runner-brightwater && cd ~/actions-runner-brightwater
curl -sSLO https://github.com/actions/runner/releases/download/v2.338.0/actions-runner-osx-arm64-2.338.0.tar.gz
shasum -a 256 actions-runner-osx-arm64-2.338.0.tar.gz   # df4cebda25c86a886ed204e49fee63f5c2e7cec5f447b5c98440a826bbdf9df2
tar xzf actions-runner-osx-arm64-2.338.0.tar.gz
./config.sh --unattended --url https://github.com/JohnnyEgghead/Brightwater --token <token> \
  --name mac --labels mac --work _work --disableupdate --replace
./svc.sh install && ./svc.sh start
```

Owner ruling 5b01b0be (Oct 31, 2026): the Mac runner runs as a LaunchAgent, and this is the form in
use (F-14). Since Oct 31 6:49 PM EDT it is the LaunchAgent
`actions.runner.JohnnyEgghead-Brightwater.mac` (`RunAtLoad` true, so it starts at login and survives a
reboot). Check it with `./svc.sh status` or `launchctl list | grep actions.runner`. The nohup form,
`nohup ./run.sh > runner.log 2>&1 &`, is kept only as a one-off debugging form; it does not survive a
reboot.

It never uses the Mac's `desktop-linux` Docker context for its own jobs: SD-38 reserves that
context for the XCUITest server under test.

## Pins

Both runners are actions/runner 2.338.0, configured with `--disableupdate` so the version moves
only by hand under the 14-day rule. Every pin is in `docs/build/P1-REPO-pins.md`.
