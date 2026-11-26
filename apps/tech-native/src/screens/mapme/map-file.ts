// SPDX-License-Identifier: AGPL-3.0-or-later
// The branch map file on the phone (SPECIFICATIONS 4.7 "The branch file, downloaded once from API-106 into app storage"; SD-34): one
// .pmtiles file per branch in the app's Documents folder, fetched from the app's own server the first time the map is wanted with signal and
// kept after that, so the map draws with no signal. iOS downloads to a temporary place and moves the file in only when it is whole.
import { Directory, File, Paths } from 'expo-file-system';
import { BRANCH_MAPS, type BranchId } from './model.ts';

/** A branch file is tens of megabytes; anything under this is not one (an error page, an empty file). */
const MIN_BYTES = 1_000_000;

function dir(): Directory {
  const d = new Directory(Paths.document, 'bw-maps');
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  return d;
}

function mapFileOf(branch: BranchId): File {
  return new File(dir(), BRANCH_MAPS[branch].file);
}

/** The kept file's URI, or null when this phone has none yet. */
export function keptMapUri(branch: BranchId): string | null {
  const f = mapFileOf(branch);
  return f.exists && f.size >= MIN_BYTES ? f.uri : null;
}

const pending = new Map<string, Promise<string>>();

/** Fetches the branch file (API-106, GET /maps/<branch>.pmtiles) into the app's storage; calls made while one runs join it. */
export function fetchMapFile(origin: string, branch: BranchId): Promise<string> {
  const key = `${origin}|${branch}`;
  const run = pending.get(key) ?? (async () => {
    const dest = mapFileOf(branch);
    const got = await File.downloadFileAsync(`${origin}/maps/${BRANCH_MAPS[branch].file}`, dest, { idempotent: true });
    if (got.size < MIN_BYTES) {
      got.delete();
      throw new Error('the map file is too small');
    }
    return got.uri;
  })().finally(() => pending.delete(key));
  pending.set(key, run);
  return run;
}

/** The bundled glyph and sprite folder's URI (xcuitest/add-map-assets.rb puts it in the app bundle as map-assets/). */
export function mapAssetsUri(): string | null {
  const d = new Directory(Paths.bundle, 'map-assets');
  return d.exists ? d.uri.replace(/\/$/, '') : null;
}
