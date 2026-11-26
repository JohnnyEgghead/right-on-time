// SPDX-License-Identifier: AGPL-3.0-or-later
// The new job page's calls (SPECIFICATIONS section 4.1: page code calls only @bw/api), each through its contract row. A Problem answer
// comes back as { ok: false } with its code and members (time_overlap's block, rule_refused's key); a network failure as `offline`.
import {
  ApiError, createClient, createJob, customerDetail, officeAvailability, searchCustomers, services, suggestTechnicians,
  type ApiClient, type AvailabilityAnswer, type ContractRow, type ServicesAnswer, type SuggestedTechniciansAnswer,
} from '@bw/api';
import type { CustomerPage, Detail } from '../customers/types.ts';
import type { Refusal } from '../job/model.ts';

export type Answer<T> = { ok: true; data: T } | Refusal;

/** What the new job call (API-28) sends: the customer, service and visit details (CTL-OFC-04-09). */
interface NewJobInput {
  customerId: string;
  serviceId: string;
  equipmentId: string | null;
  problem: string | null;
  date: string;
  windowId: string;
  technicianId: string | null;
}
/** What API-28 answers: the new job's number and the confirmation text's status, or none (GAP-10). */
export interface Created { job: { jobNumber: number }; confirmationText: { status: string } | null }

/** The calls the page makes. Previews pass a stand-in; the page uses newJobApi(). */
export interface NewJobApi {
  /** API-34: the text exactly as typed, trimmed only (CTL-OFC-04-01). */
  search(query: string): Promise<Answer<CustomerPage>>;
  /** API-35: the picked customer's branch, equipment, language and visit (CTL-OFC-04-04, CTL-OFC-04-13). */
  customer(customerId: string): Promise<Answer<Detail>>;
  /** API-110. */
  services(): Promise<Answer<ServicesAnswer>>;
  /** API-29 on the office channel: the days and windows with their room (CTL-OFC-04-06, -07, -14, -15). */
  availability(q: { branch: string; serviceId: string }): Promise<Answer<AvailabilityAnswer>>;
  /** API-30: the technicians with room, ranked (CTL-OFC-04-08). */
  suggest(q: { branch: string; date: string; windowId: string; serviceId: string; customerId: string }): Promise<Answer<SuggestedTechniciansAnswer>>;
  /** API-28. */
  create(input: NewJobInput): Promise<Answer<Created>>;
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

export function newJobApi(client: ApiClient = createClient({ baseUrl: '' })): NewJobApi {
  return {
    search: (query) => call(client, searchCustomers, { query: query.trim() }),
    customer: (customerId) => call(client, customerDetail, { customerId }),
    services: () => call(client, services, {}),
    // The server's own day range for the office channel: from demo today to the horizon (the reschedule dialog's default).
    availability: (q) => call(client, officeAvailability, { ...q, from: '2000-01-01', to: '2999-12-31', channel: 'office' }),
    suggest: (q) => call(client, suggestTechnicians, q),
    create: (input) => call(client, createJob, { ...input }),
  };
}
