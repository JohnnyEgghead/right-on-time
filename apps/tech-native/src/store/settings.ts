// SPDX-License-Identifier: AGPL-3.0-or-later
// The native app's own settings (FR-IOS-3 server address; CTL-CMP-03-01 language before sign-in): 1 small record in its own
// directory, kept by the item store's file rule (a new file per change, written whole then renamed into place, the old one removed
// after; the highest that reads back wins), so a setting saved survives a terminate and a relaunch, and a kill mid-save leaves the
// old value or the new one. Pure over StoreDir, so the tests run it on node:fs.
import { isLanguage, type Language } from '@bw/i18n/src/language.ts';
import { TEMP_PREFIX, type StoreDir } from '@bw/outbox/src/items/native.ts';
import { DEFAULT_SERVER, parseOrigin } from '../net/origin.ts';

export interface NativeSettings {
  /** The checked server origin (SCR-TEC-12 Save); the hosted demo until one is saved. */
  server: string;
  /** The language chosen on a signed-out screen (CTL-CMP-03-01), or null for the device's. */
  language: Language | null;
  /** F-987: the first open of this install has happened (the marker lives with the app's files, which a delete removes; the Keychain outlives them). */
  opened: boolean;
}

const DEFAULT_SETTINGS: NativeSettings = { server: DEFAULT_SERVER, language: null, opened: false };

const NAME = /^s-(\d{6,})\.json$/;

export class SettingsFile {
  private readonly dir: StoreDir;

  constructor(dir: StoreDir) {
    this.dir = dir;
    for (const n of dir.list()) if (n.startsWith(TEMP_PREFIX)) dir.remove(n);
  }

  private revs(): { rev: number; name: string }[] {
    return this.dir.list().flatMap((name) => {
      const m = NAME.exec(name);
      return m ? [{ rev: Number(m[1]), name }] : [];
    }).sort((a, b) => b.rev - a.rev);
  }

  read(): NativeSettings {
    for (const r of this.revs()) {
      const text = this.dir.readText(r.name);
      if (text === null) continue;
      try {
        const v = JSON.parse(text) as Partial<NativeSettings>;
        const server = typeof v.server === 'string' ? parseOrigin(v.server) : null;
        return { server: server ?? DEFAULT_SERVER, language: isLanguage(v.language) ? v.language : null, opened: v.opened === true };
      } catch {
        // a damaged record: the one below it is the last good one
      }
    }
    return DEFAULT_SETTINGS;
  }

  write(patch: Partial<NativeSettings>): NativeSettings {
    const next = { ...this.read(), ...patch };
    const old = this.revs();
    this.dir.create(`s-${String((old[0]?.rev ?? 0) + 1).padStart(6, '0')}.json`, JSON.stringify(next));
    for (const o of old) this.dir.remove(o.name);
    return next;
  }
}
