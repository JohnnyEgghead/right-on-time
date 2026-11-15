// SPDX-License-Identifier: AGPL-3.0-or-later
// The technician item handlers (UI-SPECIFICATION 12.2 API-102, API-103, API-162, API-39; SPECIFICATIONS section 5.1 and
// section 11.6's home of invariant 1, `handlers/techItems.ts` `applyItem`). Each is the HTTP face of 1 service of
// ../tech-items/: it resolves the calling technician, parses the item times (RFC 9557, offset checked), and answers.
// The services run in the kernel's 1 transaction (SD-6), 1 savepoint per item.
import type {
  markHandled as markHandledRow, reportSync as reportSyncRow, sendItems as sendItemsRow, uploadBlob as uploadBlobRow,
} from '@bw/api';
import { queuedItem } from '@bw/api';
import { catalogs } from '@bw/i18n/src/catalog.ts';
import { fromWire, realNow, type Instant } from '@bw/time';
import type { z } from 'zod';
import { applyItems, type QueuedItem } from '../tech-items/apply.ts';
import { applyBlob } from '../tech-items/blob.ts';
import { markHandled } from '../tech-items/conflicts.ts';
import { readTechnician, type ItemContext, type ItemFacts } from '../tech-items/shared.ts';
import { reportSync } from '../tech-items/sync.ts';
import type { ApiRequest, ApiResult, Handler, HandlerContext, Tx } from '../types.ts';

export { applyItem, applyItems } from '../tech-items/apply.ts';

type Out<T extends { response: z.ZodType }> = z.infer<T['response']>;
type In<T extends { request: z.ZodType }> = z.infer<T['request']>;

const DEFAULT_LINK_HOST = 'bw.j7l.io';
const DEFAULT_PHOTOS_DIR = '/data/photos';

const instant = (wire: string): Instant => fromWire(wire).toInstant();

class BadTime extends Error {}
function times(raw: { deviceTime: string; offsetSavedReal: string; demoTime: string }) {
  try {
    return { deviceTime: instant(raw.deviceTime), offsetSavedReal: instant(raw.offsetSavedReal), demoTime: instant(raw.demoTime) };
  } catch {
    throw new BadTime();
  }
}

/** The calling technician and the send's clock facts; null when the caller is not a technician with a technician row. */
async function itemContext(req: ApiRequest, tx: Tx): Promise<ItemContext | null> {
  if (req.caller.kind !== 'staff') return null;
  const technician = await readTechnician(tx, req.caller.userId);
  return technician ? { technician, receivedAt: req.demoNow, receivedReal: realNow('offline_entry'), worldEpoch: req.worldEpoch } : null;
}

const refuse = <T>(code: 'not_found' | 'validation_failed' | 'forbidden'): ApiResult<T> =>
  ({ ok: false, status: code === 'not_found' ? 404 : code === 'forbidden' ? 403 : 422, code });

/** The technician item handlers. The on-the-way text renders the shipped catalog (@bw/i18n), never a test's own (F-470). */
export function techItemHandlers(): Record<'API-102' | 'API-103' | 'API-162' | 'API-39', Handler<unknown>> {
  const linkHost = (ctx: HandlerContext) => ctx.settings.TEXT_LINK_HOST ?? DEFAULT_LINK_HOST;

  const sendItems: Handler<Out<typeof sendItemsRow>> = async (req, tx, hctx) => {
    const ctx = await itemContext(req, tx);
    if (!ctx) return refuse('forbidden');
    const p = req.params as In<typeof sendItemsRow>;
    // F-488: each item is checked on its own (queuedItem's caps, then its times); 1 that fails is refused alone, in its
    // place in the answer, and the rest of the send applies (section 5.1 step 10).
    const parsed = p.items.map((sent): QueuedItem | null => {
      const one = queuedItem.safeParse(sent);
      if (!one.success) return null;
      const raw = one.data;
      try {
        const facts: ItemFacts = {
          key: raw.key.toLowerCase(), jobNumber: raw.jobNumber, kind: raw.kind, baseVersion: raw.baseVersion, worldEpoch: raw.worldEpoch,
          sinceSaveMs: raw.sinceSaveMs, ...times(raw),
        };
        if (raw.kind === 'note') return { ...facts, kind: 'note', text: raw.payload.text };
        if (raw.kind === 'finished') return { ...facts, kind: 'finished', finish: raw.payload };
        return { ...facts, kind: raw.kind };
      } catch (e) {
        if (e instanceof BadTime) return null;
        throw e;
      }
    });
    const items = parsed.filter((it): it is QueuedItem => it !== null);
    const applied = await applyItems(tx, ctx, { catalogs, linkHost: linkHost(hctx) }, items);
    let next = 0;
    const answers = parsed.map((it, i) =>
      it === null
        ? { key: p.items[i]!.key.toLowerCase(), result: 'refused' as const, code: 'validation_failed' as const, messageKey: 'error.validation_failed', values: null }
        : applied[next++]!,
    );
    return { ok: true, status: 200, data: { items: answers } };
  };

  const upload: Handler<Out<typeof uploadBlobRow>> = async (req, tx, hctx) => {
    const ctx = await itemContext(req, tx);
    if (!ctx) return refuse('forbidden');
    const p = req.params as In<typeof uploadBlobRow>;
    if (!(req.body instanceof Uint8Array)) return refuse('validation_failed');
    let t: ReturnType<typeof times>;
    try {
      t = times(p);
    } catch {
      return refuse('validation_failed');
    }
    const out = await applyBlob(tx, ctx, hctx.settings.PHOTOS_DIR ?? DEFAULT_PHOTOS_DIR, {
      key: p.key.toLowerCase(), jobNumber: p.jobNumber, kind: p.kind, baseVersion: null, worldEpoch: p.worldEpoch, sinceSaveMs: p.sinceSaveMs, ...t,
      contentType: p.kind === 'photo' ? 'image/jpeg' : 'image/png', bytes: req.body,
    }, hctx.log);
    return { ok: true, status: 200, data: { key: p.key, result: out.answer.result as 'applied' | 'duplicate' | 'world_reset' | 'flagged', code: out.code, messageKey: out.answer.messageKey, values: out.answer.values } };
  };

  const sync: Handler<Record<string, never>> = async (req, tx) => {
    const ctx = await itemContext(req, tx);
    if (!ctx) return refuse('forbidden');
    const p = req.params as In<typeof reportSyncRow>;
    let lastSyncReal: Instant;
    try {
      lastSyncReal = instant(p.lastSyncAt);
    } catch {
      return refuse('validation_failed');
    }
    await reportSync(tx, { technicianId: ctx.technician.id, app: p.app, waitingCount: p.waitingCount, lastSyncReal, device: p.device, version: p.version, receivedAt: req.demoNow });
    return { ok: true, status: 204, data: {} };
  };

  const handled: Handler<Out<typeof markHandledRow>> = async (req, tx) => {
    if (req.caller.kind !== 'staff') return refuse('forbidden');
    const p = req.params as In<typeof markHandledRow>;
    const r = await markHandled(tx, { conflictId: p.conflictId, userId: req.caller.userId, at: req.demoNow });
    if (r.ok) return { ok: true, status: 200, data: { conflict: r.conflict } };
    if (r.code === 'not_found') return refuse('not_found');
    return { ok: false, status: 409, code: 'already_handled', detail: { by: r.by, at: r.at } };
  };

  return {
    'API-102': sendItems as Handler<unknown>,
    'API-103': upload as Handler<unknown>,
    'API-162': sync as Handler<unknown>,
    'API-39': handled as Handler<unknown>,
  };
}
