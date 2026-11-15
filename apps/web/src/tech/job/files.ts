// SPDX-License-Identifier: AGPL-3.0-or-later
// The served path of a stored photo (API-175). A harness preview registers its own pictures for the keys it draws (the preview
// has no stored file); a release page never registers any.
const overrides = new Map<string, string>();

/** The full file: only the photo viewer reads it (UD-55). */
export const fileSrc = (key: string): string => overrides.get(key) ?? `/api/v1/files/${key}`;

/** A photo tile's small copy (API-175 size thumb; SD-32, UD-55, F-1235): every tile reads it, never the full file. */
export const thumbSrc = (key: string): string => overrides.get(key) ?? `/api/v1/files/${key}?size=thumb`;

/** A preview's own picture for a key, if one is registered (a waiting photo in a preview, too). */
export const previewFile = (key: string): string | undefined => overrides.get(key);

/** Harness previews only. */
export function registerPreviewFiles(files: ReadonlyMap<string, string>): void {
  for (const [k, v] of files) overrides.set(k, v);
}
