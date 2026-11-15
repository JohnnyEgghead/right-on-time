// SPDX-License-Identifier: AGPL-3.0-or-later
// StoreDir on the phone: 1 directory under the app's Documents (kept by iOS until the app is deleted; Caches can be purged), through
// expo-file-system's synchronous File API. create() writes the content to a temporary file and renames it into place: on APFS a
// rename to a new name is atomic, so a named file is always complete (file-store.ts).
import { randomUUID } from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { TEMP_PREFIX, type StoreDir } from '@bw/outbox/src/items/native.ts';

export function expoDir(name: string): StoreDir {
  const dir = new Directory(Paths.document, name);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const file = (n: string) => new File(dir, n);
  return {
    list: () => dir.list().flatMap((e) => (e instanceof File ? [e.name] : [])),
    readText: (n) => {
      const f = file(n);
      return f.exists ? f.textSync() : null;
    },
    readBytes: (n) => {
      const f = file(n);
      return f.exists ? f.bytesSync() : null;
    },
    create(n, content) {
      if (file(n).exists) throw new Error(`${n} exists`);
      const tmp = file(`${TEMP_PREFIX}${randomUUID()}`);
      tmp.create();
      try {
        tmp.writeSync(content);
        tmp.rename(n);
      } catch (e) {
        if (tmp.exists) tmp.delete();
        throw e;
      }
    },
    remove: (n) => {
      const f = file(n);
      if (f.exists) f.delete();
    },
    uri: (n) => file(n).uri,
  };
}
