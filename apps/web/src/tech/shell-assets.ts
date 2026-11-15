// SPDX-License-Identifier: AGPL-3.0-or-later
// The web technician app's 2 shell files (SPECIFICATIONS SD-47; NFR-09): the web app manifest and the hand-written
// service worker. The web process answers them before the page gate (src/server.ts), as it does the map's glyphs: they
// hold no data, and an installed app, or a worker updating itself, fetches them with no page around them.
//   /tech/sw.js                 the worker (src/tech/sw.js), never cached by the browser's HTTP cache, so an update is
//                               seen at the next open; Service-Worker-Allowed lets its scope be /tech, the Today route
//   /tech/manifest.webmanifest  name, start page and scope /tech, standalone, the header's teal (DK-107 .apphead), the 3 icons
//   /tech/icons/icon-N.png      the iPhone app's icon at 180, 192 and 512 px (F-934)
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const TECH_SW_PATH = '/tech/sw.js';
export const TECH_MANIFEST_PATH = '/tech/manifest.webmanifest';

/** The 3 icon sizes: 180 for iPhone (apple-touch-icon), 192 and 512 for Android. */
export const TECH_ICON_SIZES = [180, 192, 512] as const;
const ICON_PATHS: Readonly<Record<(typeof TECH_ICON_SIZES)[number], string>> = {
  180: '/tech/icons/icon-180.png',
  192: '/tech/icons/icon-192.png',
  512: '/tech/icons/icon-512.png',
};
export const techIconPath = (n: (typeof TECH_ICON_SIZES)[number]): string => ICON_PATHS[n];

/** --teal-900 (docs/design/tokens/brand.css): the app header's color, so the installed app's bar matches it. */
const TEAL_900 = '#0a3a48';
const SCREEN_BG = '#f2f4f6';

/** The manifest: the product name in English (the manifest has 1 language; the app's own words follow the person's language). */
export const TECH_MANIFEST = {
  name: 'Right On Time Web',
  short_name: 'Right On Time Web',
  start_url: '/tech',
  scope: '/tech',
  display: 'standalone',
  orientation: 'portrait',
  background_color: SCREEN_BG,
  theme_color: TEAL_900,
  // The iPhone app's icon, the Brightwater mark on a white tile (DK-117 .appicon; DK-115 Home screen icon): square, the phone rounds the corners.
  icons: TECH_ICON_SIZES.map((n) => ({ src: techIconPath(n), sizes: `${n}x${n}`, type: 'image/png', purpose: 'any' })),
};

export interface ShellAsset {
  body: Buffer;
  headers: Record<string, string>;
}

let worker: Buffer | null = null;

/** F-979: the id of the running build (Next writes it to <distDir>/BUILD_ID at build): every deploy has a new one. */
export function buildId(webDir = path.resolve(import.meta.dirname, '..', '..')): string {
  for (const dir of ['.next', '.next-preview']) {
    try {
      return readFileSync(path.join(webDir, dir, 'BUILD_ID'), 'utf8').trim().replace(/[^A-Za-z0-9_-]/g, '');
    } catch {
      // not this build
    }
  }
  return 'dev';
}

/** The worker as served: the source with the build's id in its place, so a deploy changes the worker's bytes. */
export function workerSource(source: Buffer, build: string): Buffer {
  return Buffer.from(source.toString('utf8').replace('__BW_BUILD__', build));
}

export function techShellAsset(pathname: string, read: () => Buffer = () => readFileSync(path.join(import.meta.dirname, 'sw.js')), build: () => string = buildId): ShellAsset | null {
  if (pathname === TECH_SW_PATH) {
    worker ??= workerSource(read(), build());
    return {
      body: worker,
      headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache', 'service-worker-allowed': '/tech' },
    };
  }
  if (pathname === TECH_MANIFEST_PATH) {
    return {
      body: Buffer.from(JSON.stringify(TECH_MANIFEST)),
      headers: { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'public, max-age=3600' },
    };
  }
  const icon = TECH_ICON_SIZES.find((n) => pathname === techIconPath(n));
  if (icon) {
    return {
      body: readFileSync(path.join(import.meta.dirname, 'icons', `icon-${icon}.png`)),
      headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' },
    };
  }
  return null;
}
