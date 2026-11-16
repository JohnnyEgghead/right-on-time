// SPDX-License-Identifier: AGPL-3.0-or-later
// The board's calls (SPECIFICATIONS section 4.1: page code calls only @bw/api), each through its contract row, so the
// answer is validated against the row's schema. A Problem answer comes back as { ok: false } with its code and its
// members (version_conflict's by, change and at; time_overlap's block and job; already_handled's by and at).
import {
  ApiError, assignJob, boardDay, boardDelaySample, createBlock, createClient, deleteBlock, markHandled, moveBlock, movePreview, suggestTechnicians, vanPositions,
  type ApiClient, type ContractRow, type MovePreviewAnswer, type SuggestedTechniciansAnswer,
} from '@bw/api';
import type { DelaySample } from './delay-samples.ts';
import type { Board, Conflict, Van } from './model.ts';

export type Refusal = { ok: false; code: string; status: number; detail: Record<string, unknown> };
export type Answer<T> = { ok: true; data: T } | Refusal;

/** The time_overlap members (FR-DISP-34, OI-41): the block and the job whose planned time would overlap it. */
export interface OverlapDetail {
  block: { blockId: string; label: string; place: string | null; start: string; end: string };
  job: { jobNumber: number; plannedArrival: string; plannedEnd: string };
}

export type Preview = MovePreviewAnswer;
export type Suggested = SuggestedTechniciansAnswer['technicians'][number];

/** The calls the board makes. Tests and preview states pass a stand-in; the page uses boardApi(). */
export interface BoardApi {
  board(branch: string, date: string): Promise<Answer<Board>>;
  /**
   * API-21: the van positions at demo now, re-read every 10 s (SD-47, GAP-7), with the answer's worldEpoch. `have` names the route
   * lines the board holds (F-817): their routes answer track null.
   */
  vans(branch: string, have?: readonly string[]): Promise<Answer<{ vans: Van[]; worldEpoch: number }>>;
  preview(jobNumber: number, technicianId: string | null): Promise<Answer<Preview>>;
  suggest(q: { branch: string; date: string; windowId: string; serviceId: string; jobNumber: number }): Promise<Answer<{ technicians: Suggested[] }>>;
  assign(jobNumber: number, technicianId: string | null, baseVersion: number): Promise<Answer<unknown>>;
  createBlock(b: { technicianId: string; date: string; label: string; place: string | null; start: string; end: string }): Promise<Answer<unknown>>;
  moveBlock(b: { blockId: string; technicianId: string; start: string; end: string; baseVersion: number }): Promise<Answer<unknown>>;
  deleteBlock(blockId: string): Promise<Answer<unknown>>;
  markHandled(conflictId: string): Promise<Answer<unknown>>;
  /** API-172 (SD-43, F-885): 1 batch of held samples; keepalive for the send of a page being hidden. Never throws. */
  delaySamples(samples: DelaySample[], keepalive: boolean): Promise<void>;
}

async function call<T>(client: ApiClient, row: ContractRow, input: Record<string, unknown>): Promise<Answer<T>> {
  try {
    const r = await client.call(row, input as never);
    return { ok: true, data: r.data as T };
  } catch (e) {
    return refusalOf(e);
  }
}

function refusalOf(e: unknown): Refusal {
  if (e instanceof ApiError) {
    const { code, status, ...rest } = e.problem as unknown as { code: string; status: number } & Record<string, unknown>;
    return { ok: false, code, status, detail: rest };
  }
  return { ok: false, code: 'offline', status: 0, detail: {} };
}

/** A client whose requests outlive the page (fetch keepalive): SD-43's send when the page is hidden. */
export const keepaliveClient = (): ApiClient => createClient({ baseUrl: '', fetch: (url, init) => fetch(url, { ...init, keepalive: true }) });

export function boardApi(client: ApiClient = createClient({ baseUrl: '' }), kept: ApiClient = keepaliveClient()): BoardApi {
  return {
    board: (branch, date) => call<Board>(client, boardDay, { branch, date }),
    vans: async (branch, have = []) => {
      try {
        const r = await client.call(vanPositions, { branch, ...(have.length > 0 ? { have: have.join(',') } : {}) });
        return { ok: true, data: { vans: r.data.vans as Van[], worldEpoch: r.envelope?.meta.worldEpoch ?? 0 } };
      } catch (e) {
        return refusalOf(e);
      }
    },
    preview: (jobNumber, technicianId) => call<Preview>(client, movePreview, { jobNumber, technicianId }),
    suggest: (q) => call(client, suggestTechnicians, q),
    assign: (jobNumber, technicianId, baseVersion) => call(client, assignJob, { jobNumber, technicianId, baseVersion }),
    createBlock: (b) => call(client, createBlock, b),
    moveBlock: (b) => call(client, moveBlock, b),
    deleteBlock: (blockId) => call(client, deleteBlock, { blockId }),
    markHandled: (conflictId) => call(client, markHandled, { conflictId }),
    delaySamples: async (samples, keepalive) => {
      await call(keepalive ? kept : client, boardDelaySample, { samples });
    },
  };
}

/** The version_conflict members of a refusal, or null. */
export function conflictOf(r: Refusal): Conflict | null {
  return r.code === 'version_conflict' ? (r.detail as unknown as Conflict) : null;
}
export function overlapOf(r: Refusal): OverlapDetail | null {
  return r.code === 'time_overlap' && r.detail.block && r.detail.job ? (r.detail as unknown as OverlapDetail) : null;
}
