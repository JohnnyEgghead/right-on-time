// SPDX-License-Identifier: AGPL-3.0-or-later
// The booking site's calls (SPECIFICATIONS section 4.1: page code calls only @bw/api), each through its contract row. A Problem answer comes
// back as { ok: false } with its code and members (window_full's open windows); a network failure as `offline`. Every call is public: no
// session, no account (FR-AUTH-2).
import {
  ApiError, bookingSummary, bookOnline, createClient, onlineAvailability, searchStreets, services,
  type ApiClient, type BookedAnswer, type BookingSummaryAnswer, type ContractRow, type OnlineAvailabilityAnswer, type ServicesAnswer,
} from '@bw/api';
import type { Refusal } from '../job/model.ts';
import type { Street } from './model.ts';

export type Answer<T> = { ok: true; data: T } | Refusal;

/** What the booking call (API-113) takes: the service, address, day, window and contact (CTL-CUS-01-13, CTL-CUS-02-03). */
interface BookInput {
  serviceId: string; streetId: string; houseNumber: number; date: string; windowId: string; name: string; mobile: string | null;
  textsOn: boolean; textLanguage: 'en' | 'es'; timeZone: string;
}

/** The calls the pages make. Previews and tests pass a stand-in; the pages use bookingApi(). */
export interface BookingApi {
  /** API-110. */
  services(): Promise<Answer<ServicesAnswer>>;
  /** API-111: the text exactly as typed, after 2 characters (CTL-CUS-01-04). */
  streets(query: string): Promise<Answer<{ streets: Street[] }>>;
  /** API-112: the street's branch's days and windows under the online rules. */
  availability(q: { streetId: string; serviceId: string }): Promise<Answer<OnlineAvailabilityAnswer>>;
  /** API-113. */
  book(input: BookInput): Promise<Answer<BookedAnswer>>;
  /** API-114. */
  summary(bookingToken: string): Promise<Answer<BookingSummaryAnswer>>;
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

export function bookingApi(client: ApiClient = createClient({ baseUrl: '' })): BookingApi {
  return {
    services: () => call(client, services, {}),
    streets: (query) => call(client, searchStreets, { query: query.trim() }),
    // The server clamps the range to demo today and the 21-day horizon.
    availability: (q) => call(client, onlineAvailability, { ...q, from: '2000-01-01', to: '2999-12-31' }),
    book: (input) => call(client, bookOnline, { ...input }),
    summary: (bookingToken) => call(client, bookingSummary, { bookingToken }),
  };
}

/** The browser's time zone, sent with the booking (CTL-CUS-01-13); the server falls back to the branch's when it is not a zone. */
export function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
  } catch {
    return 'America/New_York';
  }
}
