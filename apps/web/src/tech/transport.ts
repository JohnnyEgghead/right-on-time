// SPDX-License-Identifier: AGPL-3.0-or-later
// The web technician app's transport for the shared send loop (@bw/outbox send.ts; SPECIFICATIONS section 5.1 step 2): API-102
// through the typed @bw/api client, API-103 as its raw-body upload (the contract's facts in the query, the bytes as the body; the typed
// client sends JSON bodies only). The answers are read by the mapping both apps share (@bw/outbox wire.ts, P6-NATIVE-SHELL).
// F-978: a stored photo the server would refuse unread (over the cap, or not a JPEG or PNG) is sent with no bytes
// (job/photo.ts uploadBody), so API-103 answers it flagged and lists it for the dispatcher and it leaves the phone.
import { fillPath, sendItems, servedPath, uploadBlob, type ApiClient } from '@bw/api';
import { blobContentType, blobQuery, failureOf, uploadAnswer, wireItem, type Transport, type WireAnswer } from '@bw/outbox/src/items/index.ts';
import { uploadBody } from './job/photo.ts';

export { failureOf, wireItem };

export function webTransport(client: ApiClient, opts: { baseUrl: string; fetch?: typeof fetch }): Transport {
  const doFetch = opts.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  return {
    async sendItems(items) {
      try {
        const r = await client.call(sendItems, { items: items.map(wireItem) as never });
        return { ok: true, answers: r.data.items as WireAnswer[] };
      } catch (e) {
        return failureOf(e);
      }
    },
    async uploadBlob(i, bytes) {
      const q = new URLSearchParams(blobQuery(i));
      const url = `${opts.baseUrl.replace(/\/$/, '')}${fillPath(servedPath(uploadBlob), { key: i.key })}?${q.toString()}`;
      let res: Response;
      try {
        res = await doFetch(url, {
          method: 'PUT', body: uploadBody(bytes) as BodyInit,
          headers: { accept: 'application/json, application/problem+json', 'content-type': blobContentType(i) },
        });
      } catch {
        return { ok: false, stop: 'network' };
      }
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        // no JSON: judged by the status alone
      }
      return uploadAnswer(res.status, body);
    },
  };
}
