# secret-scan and the privacy scan (P7-SCANS)

Two scans, 2 gates. Both are active (markers in `ci/active/`).

| Gate | What it scans | Script |
|---|---|---|
| `G-CI6` (inv6-no-pii-in-links-logs, NFR-05) | after the full end-to-end run: every container log, every issued link, for every customer phone and address in the database | `ci/gates/G-CI6.sh`, `ci/privacy-scan/scan.ts`, the collect step in `ci/e2e-stack.sh` (`BW_E2E_PRIVACY_SCAN=1`) |
| `privacy-secret-scan` (NFR-14) | gitleaks 8.30.1 over the publish set `scripts/publish.sh --dry-run` lists | `ci/gates/privacy-secret-scan.sh`, `ci/secret-scan/scan.ts` |

## Re-scan at release (P8-PUBLISH reads this)

P8-PUBLISH re-scans the final publish set with the same call, on the release ref:

    node ci/secret-scan/scan.ts run --ref <release tag or commit>

It uses `ci/secret-scan/gitleaks.toml`, so it reads the allowances below with no extra step. Exit 0 means 0 hits.
`node ci/secret-scan/scan.ts allowance` re-proves the allowances on synthetic trees.

## The allowances (F-341, W-43)

`ci/secret-scan/gitleaks.toml` holds exactly 2 allowances. Each is a file path plus a rule id with a written reason. No allowance names a secret string or a stopword.

1. **The published sample seed.** `.env.example` at the repository root (made by P8-PUBLIC-FILES, F-321) holds the 1 published value of `SAMPLE_PASSWORD_SEED` (SPECIFICATIONS section 11.1, "the published value in `.env.example`"). Its key name makes the `generic-api-key` rule fire. The allowance is path `^\.env\.example$` and rule `generic-api-key` only.
   - The same value in any other file still fails (a nested `infra/.env.example`, `.env.sample`).
   - Any other rule inside `.env.example` still fails (a real access key pasted there).
   - Before `.env.example` exists the allowance matches nothing, so the P7-SCANS run and the re-scan use the same config. If P8-PUBLISH's re-scan fails on `.env.example` with another rule, that is a real hit.
2. **Idempotency keys.** A UUID in a test file or a spike note (`key: <uuid>`) is a public row id (invariant 1), not a credential. Allowed only when the matched value is exactly UUID-shaped, the file is `*.test.ts(x)` or under `docs/build/spikes/`, and the rule is `generic-api-key`.

To change an allowance, edit the toml and the probes in `ci/secret-scan/scan.ts` (`allowanceProbes`) in 1 commit.

## What each scan covers, and what it does not

Secret scan:
- Covers every file of the tree at the ref, minus the private paths list (`scripts/private-paths.txt`). It scans text; gitleaks does not decode binary files, archives or images.
- F-1528: with the default rules on, gitleaks also skips some files by its built-in path allowlist, without a word: lock files (`pnpm-lock.yaml`, `package-lock.json`), `gitleaks.toml`, fonts and images. A trace run lists them (27 in the publish set at P8-PUBLISH, 5 of them text). The text ones (no NUL byte in the first 8 KB) are scanned a second time as copies under neutral names, and a hit there names the real path. `run --plant` and the allowance probes plant a key in `pnpm-lock.yaml` to prove it. The binary ones (fonts, images) stay unread.
- Does not scan git history: the publish set is a tree snapshot.
- The call is `gitleaks dir .` from the export root (the tool takes 1 path per call, so the export root is the one path), then the second pass above.
- `node ci/secret-scan/scan.ts dir <path>` scans an export already on disk: `scripts/publish.sh prepare` runs it on the tree it is about to commit.
- A hit prints file, line and rule only. Check its shape with `-f json` before judging it: idempotency UUIDs trip `generic-api-key`.

Privacy scan:
- Logs: every container the run made (all services, the migrate and setup runs). The setup run's container is removed on exit, so its captured output (`setup.log`) stands for it.
- Links: link tokens (rendered under every SPECIFICATIONS 11.4 prefix), customer inbox tokens, booking tokens, alert link targets, links inside text bodies.
- Database: every customer's mobile and home phone (10 digits, 7 digits without the area code), house number plus street name.
- Not covered: log output of the host-side suite process (the browsers), a street written in an abbreviation the database does not hold ("Dr" for "Drive"), a phone with letters inside it, a phone split across more than 4 digit groups, and any customer added by a flow the e2e run does not run.
- The e2e run's own seed world holds the customers; the scan reads whatever the database holds at the end of the run.
