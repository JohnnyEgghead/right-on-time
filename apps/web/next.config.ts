// SPDX-License-Identifier: AGPL-3.0-or-later
// The web app's build config (P2-SHELL; SPECIFICATIONS SD-2: Next.js 16.4.2 serves every web surface).
//
// 2 builds from 1 tree:
//   release (default): the image's web entry (infra/image/Dockerfile). Only page.tsx,
//     layout.tsx, route.ts and the other plain conventions are routes.
//   harness (BW_WEB_PREVIEW=1): also compiles the *.preview.tsx files, the shell preview routes under
//     /shell-preview that render each shared component and surface header in the states its kit frame shows
//     (the look comparator, the page walkers and the stack Playwright test read them). Built to .next-preview, so a
//     release build never contains a preview route: the files are not routes unless their extension is listed.
import path from 'node:path';
import type { NextConfig } from 'next';

const preview = process.env.BW_WEB_PREVIEW === '1';
const repoRoot = path.resolve(import.meta.dirname, '../..');

const config: NextConfig = {
  distDir: preview ? '.next-preview' : '.next',
  pageExtensions: preview ? ['preview.tsx', 'tsx', 'ts'] : ['tsx', 'ts'],
  // No standalone output: the web process (src/server.ts) serves <distDir> through Next's request handler, behind the
  // kernel and the page gate, with the build's resolved config (<distDir>/required-server-files.json).
  // No image optimizer: it would need the native sharp binary of the build machine inside a cross-architecture image.
  images: { unoptimized: true },
  outputFileTracingRoot: repoRoot,
  turbopack: {
    root: repoRoot,
    // F-1896: every page sheet (apps/web/styles/page-*.css, the kit's byte copies) is bundled with its rules scoped to its
    // own screens (src/shell/css/page-scope.ts), so a sheet left in the document after a client move never reaches the
    // next screen. The scope is a 0-specificity :where(), so the cascade among the rules that apply is unchanged.
    rules: {
      '*.css': {
        condition: { path: /(^|\/)apps\/web\/styles\/page-[a-z0-9-]+\.css$/ },
        loaders: [path.join(import.meta.dirname, 'src/shell/css/page-scope-loader.ts')],
        type: 'css',
      },
    },
  },
  transpilePackages: ['@bw/api', '@bw/i18n', '@bw/outbox', '@bw/sms', '@bw/time'],
  poweredByHeader: false,
  reactStrictMode: true,
  // The repo's typecheck gate (pnpm -r typecheck) checks apps/web with its own tsconfig; the build does not repeat it.
  typescript: { ignoreBuildErrors: true },
  // forbidden() renders SCR-SHR-01 with status 403 (F-129: keyed on the error code forbidden, never on the status).
  experimental: { authInterrupts: true },
};

export default config;
