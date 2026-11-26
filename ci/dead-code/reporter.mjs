// SPDX-License-Identifier: AGPL-3.0-or-later
// The knip reporter of ci/dead-code.ts: 1 JSON line with what knip found and how many files it read. knip's own JSON reporter
// leaves out the file count and a failed load of a tool's config file, so a run that read nothing would look like a clean one.
export default function report({ issues, counters, hasConfigLoadErrors }) {
  const found = [];
  for (const kind of ['files', 'exports', 'types', 'nsExports', 'nsTypes']) {
    for (const byFile of Object.values(issues[kind] ?? {})) {
      for (const i of Object.values(byFile)) found.push({ kind, file: i.filePath, symbol: kind === 'files' ? null : i.symbol });
    }
  }
  console.log(JSON.stringify({ read: counters.total, configErrors: hasConfigLoadErrors === true, found }));
}
