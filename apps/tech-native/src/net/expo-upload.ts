// SPDX-License-Identifier: AGPL-3.0-or-later
// UploadPort on the phone: expo-file-system's UploadTask in a background URLSession (sessionType background), which iOS keeps running
// after the app is left (R4 sections 1.1 to 1.3). The task object cancels its upload when it is released (FileSystemUploadTask
// sharedObjectWillRelease), so every running task is held here until it settles. Request bodies (API-102 batches) are files in their
// own directory; the open removes any a terminated app left behind.
import { randomUUID } from 'expo-crypto';
import { Directory, File, Paths, UploadTask } from 'expo-file-system';
import type { UploadPort } from './transport.ts';

const running = new Set<UploadTask>();
let bodies: Directory | null = null;

/** The request bodies' directory, emptied once per process: a terminated app's bodies go (their items still wait and are sent again). */
function bodyDir(): Directory {
  if (bodies) return bodies;
  const d = new Directory(Paths.document, 'bw-outgoing');
  if (d.exists) d.delete();
  d.create({ intermediates: true, idempotent: true });
  bodies = d;
  return d;
}

export function expoUpload(): UploadPort {
  return {
    async upload(fileUri, url, init) {
      const task = new UploadTask(new File(fileUri), url, { httpMethod: init.method, headers: init.headers, sessionType: 'background' });
      running.add(task);
      try {
        const r = await task.uploadAsync();
        return { status: r.status, body: r.body, headers: r.headers };
      } finally {
        running.delete(task);
      }
    },
    bodyFile(text) {
      const f = new File(bodyDir(), `${randomUUID()}.json`);
      f.create();
      f.writeSync(text);
      return { uri: f.uri, done: () => (f.exists ? f.delete() : undefined) };
    },
  };
}
