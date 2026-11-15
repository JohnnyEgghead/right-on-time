// SPDX-License-Identifier: AGPL-3.0-or-later
// API-130 search jobs, customers and addresses (UI-SPECIFICATION 12.2, CTL-CMP-07-05; SPECIFICATIONS FR-DISP-11,
// FR-DISP-7, NFR-05): the office top bar's 1 box, within the chosen branch.
//   jobs       by number: an all-digit query matches job numbers starting with it, the exact number first
//   customers  by folded name: the query folded as customer.name_search is (@bw/db foldStreetName), matched as a substring
//   addresses  by street name and house number: "<number> <street words>" matches that house number on streets whose
//              folded name holds the words; street words alone match every address on those streets
// Each group holds at most SEARCH_GROUP_CAP rows (1 more is read to set its more flag). Merged customers are left out
// (customer.status, SPECIFICATIONS section 3). The query arrives in the request body only (the row is a POST), is bound
// as a parameter, never written into SQL text (FR-DISP-7), and is never logged: the kernel logs the contract, the route
// and the status, never a parameter (NFR-05).
import { SEARCH_GROUP_CAP, type search } from '@bw/api';
import { foldStreetName } from '@bw/db';
import { areaName } from '@bw/domain';
import { Temporal, toWire } from '@bw/time';
import type { z } from 'zod';
import type { Handler, Tx } from '../types.ts';

type SearchAnswer = z.infer<typeof search.response>;
type SearchIn = z.infer<typeof search.request>;

/** What a query asks for, after folding: a job number, name words, and an address (house number and street words). */
export interface SearchTerms {
  jobPrefix: string | null;
  name: string | null;
  house: number | null;
  street: string | null;
}

export function searchTerms(query: string): SearchTerms {
  const folded = foldStreetName(query);
  const digitsOnly = /^\d+$/.test(folded);
  const m = /^(\d{1,5}) (.+)$/.exec(folded);
  return {
    jobPrefix: digitsOnly && folded.length <= 9 ? folded : null,
    name: folded !== '' && !digitsOnly ? folded : null,
    house: m ? Number(m[1]) : null,
    street: m ? m[2]! : folded !== '' && !digitsOnly ? folded : null,
  };
}

const LIMIT = SEARCH_GROUP_CAP + 1;
const instant = (d: Date) => Temporal.Instant.fromEpochMilliseconds(d.getTime());

async function jobs(tx: Tx, branch: string, prefix: string) {
  const r = await tx.query<{ job_number: number; name: string; date: string; zone: string; window_start: Date; window_end: Date; status: string }>(
    `SELECT j.job_number, c.name, j.date, j.zone, j.window_start, j.window_end, j.status
       FROM world.job j JOIN world.customer c ON c.id = j.customer_id
      WHERE j.branch_id = $1 AND j.job_number::text LIKE $2 || '%'
      ORDER BY (j.job_number::text = $2) DESC, j.job_number
      LIMIT ${LIMIT}`,
    [branch, prefix],
  );
  return r.rows.map((j) => ({
    jobNumber: j.job_number, customer: j.name, day: j.date, status: j.status,
    window: { start: toWire(instant(j.window_start), j.zone), end: toWire(instant(j.window_end), j.zone) },
  }));
}

async function customers(tx: Tx, branch: string, name: string) {
  const r = await tx.query<{ id: string; name: string; city: string; zip: string; member: boolean }>(
    `SELECT c.id, c.name, s.city, s.zip, (m.customer_id IS NOT NULL) AS member
       FROM world.customer c JOIN world.street s ON s.id = c.street_id LEFT JOIN world.membership m ON m.customer_id = c.id
      WHERE c.branch_id = $1 AND c.status = 'active' AND strpos(c.name_search, $2) > 0
      ORDER BY (c.name_search LIKE $2 || '%') DESC, c.name_search, c.id
      LIMIT ${LIMIT}`,
    [branch, name],
  );
  return r.rows.map((c) => ({ id: c.id, name: c.name, area: areaName(c.city, c.zip), plan: c.member ? ('comfort_club' as const) : null }));
}

async function addresses(tx: Tx, branch: string, street: string, house: number | null) {
  const r = await tx.query<{ id: string; house_number: number; street: string; city: string }>(
    `SELECT c.id, c.house_number, s.name AS street, s.city
       FROM world.customer c JOIN world.street s ON s.id = c.street_id
      WHERE c.branch_id = $1 AND c.status = 'active' AND strpos(s.name_search, $2) > 0 AND ($3::integer IS NULL OR c.house_number = $3)
      ORDER BY s.name_search, c.house_number, c.id
      LIMIT ${LIMIT}`,
    [branch, street, house],
  );
  return r.rows.map((a) => ({ customerId: a.id, address: `${a.house_number} ${a.street}, ${a.city}` }));
}

const capped = <T>(rows: T[]) => ({ rows: rows.slice(0, SEARCH_GROUP_CAP), more: rows.length > SEARCH_GROUP_CAP });

export const searchHandler: Handler<SearchAnswer> = async (req, tx) => {
  const { query, branch } = req.params as SearchIn;
  const t = searchTerms(query);
  const j = capped(t.jobPrefix ? await jobs(tx, branch, t.jobPrefix) : []);
  const c = capped(t.name ? await customers(tx, branch, t.name) : []);
  const a = capped(t.street ? await addresses(tx, branch, t.street, t.house) : []);
  return {
    ok: true,
    status: 200,
    data: { jobs: j.rows, customers: c.rows, addresses: a.rows, more: { jobs: j.more, customers: c.more, addresses: a.more } },
  };
};
