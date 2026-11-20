// SPDX-License-Identifier: AGPL-3.0-or-later
// The web build's CSS step for the page sheets (F-1896): next.config.ts runs every apps/web/styles/page-*.css through this
// loader (turbopack.rules), which returns the sheet with its rules scoped to its screens (page-scope.ts). The source file
// stays the kit's byte copy; only the bundled copy carries the scope. A page sheet with no scope stops the build.
import path from 'node:path';
import { PAGE_SCOPES, PAGE_SHEET_NAME, scopeSheet } from './page-scope.ts';

export function scopePageSheet(resourcePath: string, source: string): string {
  const file = path.basename(resourcePath);
  if (!PAGE_SHEET_NAME.test(file)) throw new Error(`page-scope: ${resourcePath} is not a page sheet (page-<name>.css)`);
  const scope = PAGE_SCOPES[file];
  if (!scope) throw new Error(`page-scope: ${file} has no screen in PAGE_SCOPES (apps/web/src/shell/css/page-scope.ts); a page sheet is never bundled unscoped`);
  return scopeSheet(source, scope);
}

export default function pageScopeLoader(this: { resourcePath: string }, source: string): string {
  return scopePageSheet(this.resourcePath, source);
}
