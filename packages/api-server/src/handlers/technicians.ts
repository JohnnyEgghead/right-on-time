// SPDX-License-Identifier: AGPL-3.0-or-later
// The Technicians page's calls (P4-TECHNICIANS; UI-SPECIFICATION 12.2 API-31, API-32, API-33, API-147, API-148, API-169; SPECIFICATIONS
// FR-DISP-33, FR-TEXT-11, SD-28, SD-29, OI-44):
//   API-31   technician list    the branch's technicians joined with their van, time off, user status and both app_sync_report rows,
//                               with today's load, what each is doing right now (SD-15 timing from the board's etaDay) and the vans.
//   API-32   check a text value checkNameInTexts (packages/outbox), the check API-33 also runs before it saves.
//   API-33   edit a technician  name in texts, van, skills and hours, 1 transaction; an hours edit settles the days (setWorkingHours, F-764).
//   API-147  add a technician   the Invited user of SD-29 (inviteNewUser), the technician row, the one-time email link.
//   API-148, API-169            the time off services of P3-DISPATCH-RULES (recordTimeOff, removeTimeOff).
import type { addTechnician, addTimeOff, checkTextValue, editTechnician, removeTimeOff, technicianList } from '@bw/api';
import { NAME_IN_TEXTS_MAX, checkNameInTexts } from '@bw/outbox';
import { catalogs } from '@bw/i18n/src/catalog.ts';
import { offeredWindows, technicianDayCapacity, worksOn } from '@bw/domain';
import { localDateOf } from '@bw/time';
import { publishEvent } from '@bw/db';
import type { z } from 'zod';
import { branchTechnicians, branchWindows, readDayKind, wire } from '../office-writes/day.ts';
import { recordTimeOff, removeTimeOff as removeSpan, setWorkingHours, type OffDayJob } from '../office-writes/dispatch-rules.ts';
import { WriteRefused, type WriteContext } from '../office-writes/service.ts';
import type { ApiRequest, ApiResult, Handler, Tx } from '../types.ts';
import { inviteNewUser } from './accounts.ts';
import { branchOf, dayJobs, etas } from './board.ts';

type Out<T extends { response: z.ZodType }> = z.infer<T['response']>;
type In<T extends { request: z.ZodType }> = z.infer<T['request']>;
type Row = Out<typeof technicianList>['technicians'][number];
type Skill = Row['skills'][number];

function context(req: ApiRequest): WriteContext {
  if (req.caller.kind !== 'staff') throw new Error('an office write reached its handler without a signed-in caller');
  return { actor: { kind: 'office', userId: req.caller.userId }, at: new Date(req.demoNow.epochMilliseconds) };
}

const refuse = (status: number, code: 'not_found' | 'validation_failed' | 'already_a_user' | 'rule_refused' | 'text_value_breaks_limit', detail?: unknown): ApiResult<never> =>
  ({ ok: false, status, code, ...(detail === undefined ? {} : { detail }) });

/** Run 1 time off write; a WriteRefused becomes the refusal (status is the kernel's, from the code). */
async function answer<T>(fn: () => Promise<{ status: 200 | 201 | 204; data: T }>): Promise<ApiResult<T>> {
  try {
    return { ok: true, ...(await fn()) };
  } catch (e) {
    if (e instanceof WriteRefused) return { ok: false, status: 409, code: e.code, ...(e.detail === undefined ? {} : { detail: e.detail }) };
    throw e;
  }
}

const hhmm = (t: string): string => t.slice(0, 5);
/** The last word of the name is what the list sorts by, as the frame's order (Bell, Carter, Doyle, ...). */
const surname = (name: string): string => name.trim().split(/\s+/).at(-1) ?? name;

interface TechRead {
  id: string; name: string; phone: string; branch_id: string; primary_skill: string; skills: string[]; installer: boolean; van_id: string | null;
  van_number: string | null; van_vehicle: string | null; shift_start: string; shift_end: string; working_days: number[]; saturdays: Row['saturdays'];
  name_in_texts: string; since: number; user_status: Row['userStatus']; employee_number: string | null;
}

/** The branch's technicians as API-31 answers them (`only`: 1 technician, for the writes' answers). */
async function readList(req: ApiRequest, tx: Tx, branchId: string, only?: string): Promise<ApiResult<Out<typeof technicianList>>> {
  const branch = await branchOf(tx, branchId);
  if (!branch) return refuse(404, 'not_found');
  const now = req.demoNow.epochMilliseconds;
  const today = localDateOf(req.demoNow, branch.zone);
  const kind = await readDayKind(tx, branch.id, today);
  const people = (await tx.query<TechRead>(
    `SELECT t.id, t.name, t.phone, t.branch_id, t.primary_skill, t.skills, t.installer, t.van_id, v.number AS van_number, v.vehicle AS van_vehicle,
            t.shift_start::text AS shift_start, t.shift_end::text AS shift_end, t.working_days, t.saturdays, t.name_in_texts,
            extract(year FROM t.since)::int AS since, u.status AS user_status, u.employee_number
       FROM world.technician t JOIN world."user" u ON u.id = t.user_id LEFT JOIN world.van v ON v.id = t.van_id
      WHERE t.branch_id = $1 AND ($2::uuid IS NULL OR t.id = $2::uuid)`, [branch.id, only ?? null])).rows
    .sort((a, b) => surname(a.name).localeCompare(surname(b.name), 'en') || a.name.localeCompare(b.name, 'en'));
  const ids = people.map((p) => p.id);
  const off = await tx.query<{ id: string; technician_id: string; from: string; to: string; note: string | null }>(
    `SELECT id, technician_id, from_date::text AS "from", to_date::text AS "to", note FROM world.time_off WHERE technician_id = ANY($1::uuid[]) ORDER BY from_date, id`, [ids]);
  const reports = await tx.query<{ technician_id: string; app: 'web' | 'native'; last_sync_real: Date; waiting_count: number; device: string; version: string; reported_at: Date }>(
    'SELECT technician_id, app, last_sync_real, waiting_count, device, version, reported_at FROM world.app_sync_report WHERE technician_id = ANY($1::uuid[])', [ids]);
  const facts = new Map((await branchTechnicians(tx, branch.id)).map((t) => [t.id, t] as const));
  const jobs = await dayJobs(tx, branch.id, today);

  const rows: Row[] = [];
  for (const p of people) {
    const f = facts.get(p.id);
    const mine = jobs.filter((j) => j.technician_id === p.id);
    const workingToday = f ? worksOn(f, today) : false;
    const current = mine.find((j) => j.status === 'on_the_way' || j.status === 'on_site');
    const still = mine.some((j) => j.status === 'scheduled');
    let rightNow: Row['rightNow'] = null;
    if (f && (current || (workingToday && still))) {
      const timing = (await etas(tx, branch, f, today, mine, now)).get((current ?? mine.find((j) => j.status === 'scheduled'))!.job_number)?.timing;
      const TIMING = { on_time: 'onTime', at_risk: 'atRisk', late: 'late' } as const;
      rightNow = {
        status: current ? (current.status as 'on_the_way' | 'on_site') : 'between_jobs',
        timing: timing ? TIMING[timing] : null,
        jobNumber: current?.job_number ?? null,
        customerName: current?.customer ?? null,
      };
    }
    const report = (app: 'web' | 'native') => {
      const r = reports.rows.find((x) => x.technician_id === p.id && x.app === app);
      return r ? { lastSyncAt: wire(r.last_sync_real, branch.zone), waitingCount: r.waiting_count, device: r.device, version: r.version, reportedAt: wire(r.reported_at, branch.zone) } : null;
    };
    rows.push({
      id: p.id, name: p.name, phone: p.phone, branch: p.branch_id,
      van: p.van_id && p.van_number !== null ? { id: p.van_id, number: p.van_number, vehicle: p.van_vehicle ?? '' } : null,
      skills: [p.primary_skill, ...p.skills.filter((s) => s !== p.primary_skill)] as Skill[],
      workingHours: { start: hhmm(p.shift_start), end: hhmm(p.shift_end) }, workingDays: [...p.working_days].sort(), saturdays: p.saturdays,
      todayLoad: mine.length, capacity: technicianDayCapacity({ installer: p.installer }, kind), workingToday,
      nameInTexts: p.name_in_texts, since: p.since, employeeNumber: p.employee_number, rightNow,
      timeOff: off.rows.filter((o) => o.technician_id === p.id).map((o) => ({ id: o.id, from: o.from, to: o.to, note: o.note })),
      userStatus: p.user_status, apps: { web: report('web'), native: report('native') },
    });
  }
  const vans = (await tx.query<{ id: string; number: string; vehicle: string }>('SELECT id, number, vehicle FROM world.van WHERE branch_id = $1', [branch.id])).rows
    .sort((a, b) => a.number.localeCompare(b.number, 'en', { numeric: true }));
  const sat = offeredWindows(await branchWindows(tx, branch.id), 'saturday');
  const starts = sat.map((w) => hhmm(w.startLocal)).sort();
  const ends = sat.map((w) => hhmm(w.endLocal)).sort();
  return {
    ok: true, status: 200, data: {
      branch: branch.id, zone: branch.zone, today, readAt: wire(new Date(now), branch.zone), technicians: rows, vans,
      skills: ['heating_cooling', 'plumbing', 'install'],
      saturdayHours: starts.length > 0 ? { start: starts[0]!, end: ends.at(-1)! } : null,
    },
  };
}

export const technicianListHandler: Handler<Out<typeof technicianList>> = (req, tx) => readList(req, tx, (req.params as In<typeof technicianList>).branch);

async function one(req: ApiRequest, tx: Tx, branchId: string, id: string): Promise<Row> {
  const r = await readList(req, tx, branchId, id);
  if (!r.ok || !r.data.technicians[0]) throw new Error(`technician ${id} was not read back`);
  return r.data.technicians[0];
}

export const checkTextValueHandler: Handler<Out<typeof checkTextValue>> = async (req) => {
  const p = req.params as In<typeof checkTextValue>;
  const c = checkNameInTexts(p.value, catalogs);
  const length = [...p.value].length;
  if (c.ok) return { ok: true, status: 200, data: { ok: true, problem: 'none', characters: [], length, maximum: NAME_IN_TEXTS_MAX } };
  return { ok: true, status: 200, data: { ok: false, problem: c.problem, characters: c.chars ?? [], length, maximum: NAME_IN_TEXTS_MAX } };
};

const refusedName = (c: Exclude<ReturnType<typeof checkNameInTexts>, { ok: true }>) =>
  refuse(422, 'text_value_breaks_limit', { problem: c.problem, length: c.length, limit: c.limit, ...(c.chars ? { chars: c.chars } : {}) });

/**
 * The primary skill stays when it is still held; installers are the technicians whose primary skill is install (the seed's rule). `held` is what
 * technician.skills stores: the primary first, then the others, as the seed writes it (F-767; a 1-skill technician stores {primary}, never {}).
 */
const skillsOf = (current: string, skills: readonly string[]) => {
  const primary = skills.includes(current) ? current : skills[0]!;
  return { primary, held: [primary, ...skills.filter((s) => s !== primary)], installer: primary === 'install' };
};

/** F-769 (NFR-01, CTL-OFC-02-08): a van, skill, new technician or time off changes what an open board shows, so its regions re-read (EVT-02 board.refresh). */
async function refreshBoard(tx: Tx, branch: string): Promise<void> {
  await publishEvent(tx, 'board.refresh', { branch });
}

export const editTechnicianHandler: Handler<Out<typeof editTechnician>> = async (req, tx) => {
  const p = req.params as In<typeof editTechnician>;
  // FOR NO KEY UPDATE, see setWorkingHours: it serializes 2 edits of 1 technician without blocking a job write that holds a day lock.
  const cur = (await tx.query<{ branch_id: string; primary_skill: string }>('SELECT branch_id, primary_skill FROM world.technician WHERE id = $1 FOR NO KEY UPDATE', [p.technicianId])).rows[0];
  if (!cur) return refuse(404, 'not_found');
  if (p.nameInTexts !== undefined) {
    const c = checkNameInTexts(p.nameInTexts, catalogs);
    if (!c.ok) return refusedName(c);
    await tx.query('UPDATE world.technician SET name_in_texts = $2 WHERE id = $1', [p.technicianId, p.nameInTexts]);
  }
  if (p.vanId !== undefined) {
    if (p.vanId !== null && !(await tx.query('SELECT 1 FROM world.van WHERE id = $1 AND branch_id = $2', [p.vanId, cur.branch_id])).rows[0]) return refuse(422, 'validation_failed');
    await tx.query('UPDATE world.technician SET van_id = $2 WHERE id = $1', [p.technicianId, p.vanId]);
  }
  if (p.skills !== undefined) {
    const s = skillsOf(cur.primary_skill, p.skills);
    await tx.query('UPDATE world.technician SET primary_skill = $2, skills = $3, installer = $4 WHERE id = $1', [p.technicianId, s.primary, s.held, s.installer]);
  }
  let offDayJobs: OffDayJob[] = [];
  if (p.workingHours !== undefined) {
    const branch = await branchOf(tx, cur.branch_id);
    if (!branch) throw new Error(`branch ${cur.branch_id} of technician ${p.technicianId} does not exist`);
    offDayJobs = await setWorkingHours(tx, context(req), { technicianId: p.technicianId, branch: branch.id, today: localDateOf(req.demoNow, branch.zone), hours: p.workingHours });
  }
  if (p.vanId !== undefined || p.skills !== undefined) await refreshBoard(tx, cur.branch_id); // an hours edit tells the board itself (setWorkingHours, F-822)
  return { ok: true, status: 200, data: { technician: await one(req, tx, cur.branch_id, p.technicianId), offDayJobs } };
};

/** The name in texts a new technician starts with: the first name when it passes the check, else a plain one the office edits. */
function startingNameInTexts(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? '';
  return checkNameInTexts(first, catalogs).ok ? first : 'Tech';
}

/** SD-29: the new technician's phone, in the reserved fictional range (FR-IMP-7), the lowest tail 0141 to 0199 no technician has. */
async function newPhone(tx: Tx, branchId: string): Promise<string | null> {
  const area = (await tx.query<{ office_phone: string }>('SELECT office_phone FROM world.branch WHERE id = $1', [branchId])).rows[0]?.office_phone.match(/^\((\d{3})\)/)?.[1];
  if (!area) return null;
  const used = new Set((await tx.query<{ phone: string }>('SELECT phone FROM world.technician')).rows.map((r) => r.phone));
  for (let n = 141; n <= 199; n++) {
    const phone = `(${area}) 555-0${n}`;
    if (!used.has(phone)) return phone;
  }
  return null;
}

export const addTechnicianHandler: Handler<Out<typeof addTechnician>> = async (req, tx) => {
  const ctx = context(req);
  const p = req.params as In<typeof addTechnician>;
  const branch = await branchOf(tx, p.branch);
  if (!branch) return refuse(422, 'validation_failed');
  if (p.vanId !== null && !(await tx.query('SELECT 1 FROM world.van WHERE id = $1 AND branch_id = $2', [p.vanId, branch.id])).rows[0]) return refuse(422, 'validation_failed');
  // F-765: 2 adds take turns for the next free phone; without it both read the same used set and took the same number.
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext('bw.technician_phone'))`);
  const phone = await newPhone(tx, branch.id);
  if (!phone) return refuse(409, 'rule_refused');
  const made = await inviteNewUser(tx, { by: ctx.actor.userId, now: req.demoNow.toString(), name: p.name, email: p.email, role: 'technician', branch: branch.id });
  if (!made) return refuse(409, 'already_a_user');
  const s = skillsOf(p.skills[0]!, p.skills);
  const id = (await tx.query<{ id: string }>(
    `INSERT INTO world.technician (user_id, branch_id, name, name_in_texts, phone, primary_skill, skills, installer, van_id, shift_start, shift_end, working_days, saturdays, since)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::time, $11::time, $12, $13, $14::date) RETURNING id`,
    [made.id, branch.id, p.name, startingNameInTexts(p.name), phone, s.primary, s.held, s.installer, p.vanId, p.workingHours.start, p.workingHours.end,
      [...p.workingHours.days].sort(), p.workingHours.saturdays, localDateOf(req.demoNow, branch.zone)])).rows[0]!.id;
  await refreshBoard(tx, branch.id);
  return {
    ok: true, status: 201, data: {
      technician: await one(req, tx, branch.id, id),
      user: { id: made.id, email: p.email, status: 'invited', role: 'technician' },
      emailLink: made.emailLink,
    },
  };
};

async function refreshTechnicianBoard(tx: Tx, technicianId: string): Promise<void> {
  const row = (await tx.query<{ branch_id: string }>('SELECT branch_id FROM world.technician WHERE id = $1', [technicianId])).rows[0];
  if (row) await refreshBoard(tx, row.branch_id);
}

export const addTimeOffHandler: Handler<Out<typeof addTimeOff>> = (req, tx) => answer(async () => {
  const p = req.params as In<typeof addTimeOff>;
  const done = await recordTimeOff(tx, context(req), { technicianId: p.technicianId, from: p.from, to: p.to, note: p.note && p.note !== '' ? p.note : null });
  await refreshTechnicianBoard(tx, p.technicianId);
  return { status: 201, data: done };
});

export const removeTimeOffHandler: Handler<Record<string, never>> = (req, tx) => answer(async () => {
  const p = req.params as In<typeof removeTimeOff>;
  const own = await tx.query('SELECT 1 FROM world.time_off WHERE id = $1 AND technician_id = $2', [p.spanId, p.technicianId]);
  if (!own.rows[0]) throw new WriteRefused('not_found', `time off ${p.spanId} of technician ${p.technicianId} does not exist`);
  await removeSpan(tx, context(req), { timeOffId: p.spanId });
  await refreshTechnicianBoard(tx, p.technicianId);
  return { status: 204, data: {} };
});
