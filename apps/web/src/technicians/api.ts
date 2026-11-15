// SPDX-License-Identifier: AGPL-3.0-or-later
// The Technicians page's calls (SPECIFICATIONS section 4.1: page code calls only @bw/api), each through its contract row. A Problem answer
// comes back as { ok: false } with its code and members (text_value_breaks_limit's problem, rule_refused's jobNumbers).
import {
  addTechnician, addTimeOff, ApiError, checkTextValue, createClient, editTechnician, removeTimeOff, technicianList,
  type ApiClient, type ContractRow, type TechnicianListAnswer, type TextCheckAnswer, type TimeOffAnswer,
} from '@bw/api';
import type { TechRow, TechSkill, WorkWeek } from './model.ts';

export type Refusal = { ok: false; code: string; status: number; detail: Record<string, unknown> };
export type Answer<T> = { ok: true; data: T } | Refusal;

/** A job an hours edit left on a day the technician no longer works (API-33). */
export interface OffDayJob { jobNumber: number; date: string; window: { start: string; end: string } }

/** The calls the Technicians page and its 2 dialogs make. Preview states pass a stand-in; the page uses techApi(). */
export interface TechApi {
  list(branch: string): Promise<Answer<TechnicianListAnswer>>;
  check(value: string): Promise<Answer<TextCheckAnswer>>;
  edit(id: string, e: { nameInTexts?: string; vanId?: string | null; skills?: TechSkill[]; workingHours?: WorkWeek }): Promise<Answer<{ technician: TechRow; offDayJobs: OffDayJob[] }>>;
  add(b: { name: string; email: string; branch: string; vanId: string | null; skills: TechSkill[]; workingHours: WorkWeek }): Promise<Answer<{ technician: TechRow; emailLink: string }>>;
  addTimeOff(id: string, b: { from: string; to: string; note: string | null }): Promise<Answer<TimeOffAnswer>>;
  removeTimeOff(id: string, spanId: string): Promise<Answer<Record<string, never>>>;
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

export function techApi(client: ApiClient = createClient({ baseUrl: '' })): TechApi {
  return {
    list: (branch) => call(client, technicianList, { branch }),
    check: (value) => call(client, checkTextValue, { slot: 'technician', value }),
    edit: (id, e) => call(client, editTechnician, { technicianId: id, ...e }),
    add: (b) => call(client, addTechnician, b),
    addTimeOff: (id, b) => call(client, addTimeOff, { technicianId: id, ...b }),
    removeTimeOff: (id, spanId) => call(client, removeTimeOff, { technicianId: id, spanId }),
  };
}
