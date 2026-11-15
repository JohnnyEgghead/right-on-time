// SPDX-License-Identifier: AGPL-3.0-or-later
// The job page's calls (SPECIFICATIONS section 4.1: page code calls only @bw/api), each through its contract row. A
// Problem answer comes back as { ok: false } with its code and members (rule_refused's key, time_overlap's block).
import {
  addEquipment, addOfficeNote, ApiError, assignJob, cancelJob, correctFinish, createClient, editEquipment, editJob, finishJobOffice, inboxLink, jobDetail,
  jobOnTheWay, movePreview, officeAvailability, partsList, rescheduleJob, sendOfficeText, services, suggestTechnicians,
  type ApiClient, type AvailabilityAnswer, type ContractRow, type MovePreviewAnswer, type OnTheWayAnswer, type PartsAnswer, type ServicesAnswer, type SuggestedTechniciansAnswer,
} from '@bw/api';
import type { Job, Refusal } from './model.ts';

export type Answer<T> = { ok: true; data: T } | Refusal;
export type Part = PartsAnswer['parts'][number];

/** The calls the job page and its dialogs make. Preview states pass a stand-in; the page uses jobApi(). */
export interface JobApi {
  job(jobNumber: number): Promise<Answer<Job>>;
  onTheWay(jobNumber: number): Promise<Answer<OnTheWayAnswer>>;
  parts(): Promise<Answer<PartsAnswer>>;
  services(): Promise<Answer<ServicesAnswer>>;
  availability(q: { branch: string; serviceId: string; from: string; to: string; jobNumber: number }): Promise<Answer<AvailabilityAnswer>>;
  suggest(q: { branch: string; date: string; windowId: string; serviceId: string; jobNumber: number }): Promise<Answer<SuggestedTechniciansAnswer>>;
  /** API-131: the arrival time the server estimates for a technician (or none) on this job (CTL-OFC-18-04). */
  preview(jobNumber: number, technicianId: string | null): Promise<Answer<MovePreviewAnswer>>;
  inboxLink(customerId: string): Promise<Answer<{ url: string }>>;
  assign(jobNumber: number, technicianId: string | null, baseVersion: number): Promise<Answer<unknown>>;
  reschedule(jobNumber: number, date: string, windowId: string, baseVersion: number): Promise<Answer<{ outcome: { technicianKept: boolean; textSent: boolean } }>>;
  cancel(jobNumber: number, baseVersion: number): Promise<Answer<unknown>>;
  edit(jobNumber: number, e: { serviceId: string; equipmentId: string | null; problem: string | null; baseVersion: number }): Promise<Answer<unknown>>;
  finish(jobNumber: number, f: { parts: { partId: string; quantity: number }[]; noPartsUsed: boolean; laborMinutes: number; baseVersion: number }): Promise<Answer<unknown>>;
  correct(jobNumber: number, f: { parts: { partId: string; quantity: number }[]; noPartsUsed: boolean; laborMinutes: number; baseVersion: number }): Promise<Answer<unknown>>;
  text(customerId: string, body: string, jobNumber: number | null): Promise<Answer<{ text: { status: 'sending' | 'held'; heldUntil: string | null } }>>;
  /** API-140: a note on a job (the job page) or on a customer (the customer page). */
  note(target: { jobNumber: number } | { customerId: string }, body: string): Promise<Answer<unknown>>;
  /** API-141: a new piece of equipment (the customer page's Add equipment). */
  addEquipment(e: { customerId: string; type: string; year: number | null; location: string | null; details: string | null }): Promise<Answer<unknown>>;
  equipment(e: { equipmentId: string; type?: string; year: number | null; location: string | null; details: string | null }): Promise<Answer<unknown>>;
}

async function call<T>(client: ApiClient, row: ContractRow, input: Record<string, unknown>): Promise<Answer<T>> {
  try {
    const r = await client.call(row, input as never);
    return { ok: true, data: r.data as T };
  } catch (e) {
    if (e instanceof ApiError) {
      const { code, status, ...rest } = e.problem as unknown as { code: string; status: number } & Record<string, unknown>;
      return { ok: false, code, status, detail: rest };
    }
    return { ok: false, code: 'offline', status: 0, detail: {} };
  }
}

export function jobApi(client: ApiClient = createClient({ baseUrl: '' })): JobApi {
  return {
    job: (jobNumber) => call(client, jobDetail, { jobNumber }),
    onTheWay: (jobNumber) => call(client, jobOnTheWay, { jobNumber }),
    parts: () => call(client, partsList, {}),
    services: () => call(client, services, {}),
    availability: (q) => call(client, officeAvailability, { ...q, channel: 'office' }),
    suggest: (q) => call(client, suggestTechnicians, q),
    preview: (jobNumber, technicianId) => call(client, movePreview, { jobNumber, technicianId }),
    inboxLink: (customerId) => call(client, inboxLink, { customerId }),
    assign: (jobNumber, technicianId, baseVersion) => call(client, assignJob, { jobNumber, technicianId, baseVersion }),
    reschedule: (jobNumber, date, windowId, baseVersion) => call(client, rescheduleJob, { jobNumber, date, windowId, baseVersion }),
    cancel: (jobNumber, baseVersion) => call(client, cancelJob, { jobNumber, baseVersion }),
    edit: (jobNumber, e) => call(client, editJob, { jobNumber, ...e }),
    finish: (jobNumber, f) => call(client, finishJobOffice, { jobNumber, ...f }),
    correct: (jobNumber, f) => call(client, correctFinish, { jobNumber, ...f }),
    text: (customerId, body, jobNumber) => call(client, sendOfficeText, { customerId, body, jobNumber }),
    note: (target, body) => call(client, addOfficeNote, { ...target, body }),
    addEquipment: (e) => call(client, addEquipment, e),
    equipment: (e) => call(client, editEquipment, e),
  };
}
