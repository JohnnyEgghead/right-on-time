// SPDX-License-Identifier: AGPL-3.0-or-later
// The native app's transport for the shared send loop (@bw/outbox send.ts; SPECIFICATIONS section 5.1 step 2; R4 sections 1.1 to
// 1.3). Every item call is a background upload task from a file, so a queued note or photo keeps uploading after the app is left:
// iOS runs a background URLSession upload only from a file (R4 section 1.2). API-102's body (the batch, as JSON) is written to a file
// first; API-103 uploads the photo's or signature's own file from the item store, never a copy in memory. The answers are read by
// the mapping both apps share (@bw/outbox wire.ts), API-102's through the typed client itself.
//
// Re-run semantics: an upload whose answer never reaches the app (the app terminated mid-task; iOS cancels or finishes the task
// without it) leaves the item waiting under its key; the next send repeats it and the server answers duplicate (I3). The body file of
// a batch is the request's, not the item's: it is removed when its task settles, and a leftover one is removed at the next open.
import { createClient, fillPath, sendItems, servedPath, uploadBlob } from '@bw/api';
import {
  blobContentType, blobQuery, failureOf, jsonOrNull, uploadAnswer, wireItem, type Transport, type WireAnswer,
} from '@bw/outbox/src/items/native.ts';

export interface UploadInit {
  method: 'POST' | 'PUT';
  headers: Record<string, string>;
}
export interface UploadResult {
  status: number;
  body: string;
  headers: Record<string, string>;
}

/** The phone's background upload (src/net/expo-upload.ts: expo-file-system's UploadTask in a background session). */
export interface UploadPort {
  /** Uploads the file at `fileUri`; resolves with the HTTP answer, rejects when no answer came. */
  upload(fileUri: string, url: string, init: UploadInit): Promise<UploadResult>;
  /** Writes a request body to a new file for upload; done() removes it. */
  bodyFile(text: string): { uri: string; done(): void };
}

export interface NativeTransportOptions {
  origin: string;
  token: string;
  /** Where a waiting photo's or signature's bytes are (FileItemStore.blobUri). */
  blobUri: (key: string) => string | null;
  port: UploadPort;
}

const ACCEPT = 'application/json, application/problem+json';

/**
 * A fetch for the typed client that sends its request body from a file by a background upload. Only a call with a body comes here
 * (API-102). A rejected upload is no answer at all, so it surfaces as fetch's own TypeError: the send loop's "network".
 */
export function uploadFetch(port: UploadPort): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? init.body : null;
    const method = init?.method;
    if (body === null || (method !== 'POST' && method !== 'PUT')) throw new Error('uploadFetch: only a POST or PUT with a JSON body uploads from a file');
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const file = port.bodyFile(body);
    let r: UploadResult;
    try {
      r = await port.upload(file.uri, String(input), { method, headers });
    } catch (e) {
      throw new TypeError(`Network request failed: ${(e as Error).message}`);
    } finally {
      file.done();
    }
    const h = new Map(Object.entries(r.headers).map(([k, v]) => [k.toLowerCase(), v]));
    return { status: r.status, text: async () => r.body, headers: { get: (n: string) => h.get(n.toLowerCase()) ?? null } } as unknown as Response;
  }) as typeof fetch;
}

export function nativeTransport(opts: NativeTransportOptions): Transport {
  const auth = { authorization: `Bearer ${opts.token}` };
  const items = createClient({ baseUrl: opts.origin, fetch: uploadFetch(opts.port), headers: auth });
  return {
    async sendItems(batch) {
      try {
        const r = await items.call(sendItems, { items: batch.map(wireItem) as never });
        return { ok: true, answers: r.data.items as WireAnswer[] };
      } catch (e) {
        return failureOf(e);
      }
    },
    async uploadBlob(i) {
      // The bytes the loop read are the same file's; the upload reads the file, so a large photo never crosses into JavaScript twice.
      const uri = opts.blobUri(i.key);
      if (uri === null) return { ok: false, stop: null, status: 0, code: 'blob_missing' };
      const q = new URLSearchParams(blobQuery(i));
      const url = `${opts.origin}${fillPath(servedPath(uploadBlob), { key: i.key })}?${q.toString()}`;
      let r: UploadResult;
      try {
        r = await opts.port.upload(uri, url, { method: 'PUT', headers: { ...auth, accept: ACCEPT, 'content-type': blobContentType(i) } });
      } catch {
        return { ok: false, stop: 'network' };
      }
      return uploadAnswer(r.status, jsonOrNull(r.body));
    },
  };
}
