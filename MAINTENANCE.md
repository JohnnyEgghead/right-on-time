# Maintenance

This page lists the pinned versions, the rule for new releases, and the steps to update a copy.

## Pinned versions

- Node: 26.12.1 (`.node-version`). `engines.node` in `package.json` requires Node 26.
- pnpm: 12.14.0 (the `packageManager` field in `package.json`).
- PostgreSQL: 18.
- node-forge: 1.4.3, set by the `overrides` block in `pnpm-workspace.yaml`. Remove the override when the dependency tree no longer needs it.
- Container base image: `node:26.12.1-bookworm-slim`, pinned by digest in `.github/workflows/ci.yml`.

## The 14-day rule

`pnpm-workspace.yaml` sets `minimumReleaseAge: 20160`, which is 14 days in minutes. pnpm refuses any package release that is less than 14 days old.

The install settings also block a dependency that comes from a tarball URL or a git repo (`blockExoticSubdeps`).

The trust rule (`trustPolicy: no-downgrade`) excludes one release, `semver@6.3.1` (`trustPolicyExclude`), because the committed lockfile pins it and it fails the check; remove the exclusion when the lockfile moves off that version.

## Update steps

1. Pick the new version. Check its publish date against the 14-day rule.
2. Change the pin in the file that holds it: `package.json`, `pnpm-workspace.yaml`, `.node-version`, or the workflow file.
3. Run `pnpm install`, so the lockfile updates.
4. Run `pnpm install --frozen-lockfile`. It must pass.
5. Run `pnpm run typecheck`, `pnpm run lint` and `pnpm run test`.
6. Run `pnpm audit`, and record any advisory that is still open.
7. Commit the changed files, including `pnpm-lock.yaml`.
