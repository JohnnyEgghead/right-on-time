// SPDX-License-Identifier: AGPL-3.0-or-later
// Contract rows of the customers area (P4-CUSTOMERS; UI-SPECIFICATION 12.2 and SPECIFICATIONS FR-DISP-7, FR-DISP-29 to FR-DISP-32):
// API-34 customer search, API-35 customer detail, API-36 edit customer, API-111 street search (also the street picker of
// SCR-OFC-38 and SCR-OFC-39; the public booking page uses the same row, P5-BOOKING) and API-139 create a customer.
// Phone numbers travel as E.164 text; the pages format them. Every address field is address-tagged (fictional_addresses).
import { z } from 'zod';
import { ADDRESS_TAG, addressField, defineContract, type ContractRow } from '../contract.ts';
import { localDate } from './shapes.ts';

const addressNamed = { [ADDRESS_TAG]: true };
/** An id or code that names a place: the contract gate's name rule tags every address-named field. */
const placeId = () => z.uuid().meta(addressNamed);
const wireTime = z.string().min(1);
const SAMPLE_ID = '00000000-0000-7000-8000-000000000000';

/** The most results API-34 answers at once (its `limit` default; `next` pages on). */
export const CUSTOMER_PAGE = 25;
/** The most streets API-111 answers (SPECIFICATIONS "Street picker"). */
export const STREET_CAP = 20;

const language = z.enum(['en', 'es']);
const houseNumber = z.number().int().min(1).max(99999);

/** The address API-34 and API-35 print: house number, street, city and ZIP code. */
const address = z.object({ houseNumber, street: addressField(), city: z.string(), zip: addressField() }).meta(addressNamed);

export const searchCustomers = defineContract({
  id: 'API-34',
  name: 'Search customers',
  method: 'POST',
  path: '/customer-searches',
  // A request body only: the text may be a name, a street or a phone number (UI-SPECIFICATION 12.1 item 6, NFR-05).
  request: z.object({
    query: z.string().trim().max(100),
    filters: z.object({
      branch: z.string().min(1).max(40).nullable().default(null),
      city: z.string().min(1).max(80).nullable().default(null),
      plan: z.enum(['comfort_club', 'none']).nullable().default(null),
      textLanguage: language.nullable().default(null),
      upcomingVisit: z.boolean().nullable().default(null),
    }).default({ branch: null, city: null, plan: null, textLanguage: null, upcomingVisit: null }),
    cursor: z.string().max(200).nullable().default(null),
    limit: z.number().int().min(1).max(50).default(CUSTOMER_PAGE),
  }),
  response: z.object({
    customers: z.array(z.object({
      id: z.uuid(),
      name: z.string(),
      /** The customer's city (the street's). */
      area: z.string(),
      address,
      /** E.164, or null with no mobile phone. */
      mobile: z.string().nullable(),
      textsOn: z.boolean(),
      language,
      plan: z.enum(['comfort_club']).nullable(),
      customerSince: localDate,
      /** The latest visit by date among past visits and done jobs: its date and service (a service id with `serviceId`, else the old system's words). */
      lastVisit: z.object({ date: localDate, service: z.string(), serviceId: z.string().nullable() }).nullable(),
      nextVisit: z.object({
        jobNumber: z.number().int(),
        day: localDate,
        window: z.object({ start: wireTime, end: wireTime }),
        serviceId: z.string(),
        status: z.enum(['scheduled', 'on_the_way', 'on_site']),
        technician: z.string().nullable(),
      }).nullable(),
    })),
    /** All customers the search and filters match (the whole list with neither). */
    total: z.number().int().min(0),
    next: z.string().nullable(),
    /** The cities of the street list in the filtered branch (all branches when none): the City filter's choices (CTL-OFC-05-07). */
    cities: z.array(z.string()),
  }),
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', input: { query: "o'brien" }, expectStatus: 401 }],
});

const equipmentRow = z.object({
  id: z.uuid(),
  type: z.string(),
  year: z.number().int().nullable(),
  location: z.string().nullable(),
  details: z.string().nullable(),
});

export const customerDetail = defineContract({
  id: 'API-35',
  name: 'Customer detail',
  method: 'GET',
  path: '/customers/{customerId}',
  request: z.object({ customerId: z.uuid() }),
  response: z.object({
    id: z.uuid(),
    name: z.string(),
    branch: z.string(),
    /** The customer's city (the street's). */
    area: z.string(),
    contact: z.object({
      mobile: z.string().nullable(),
      homePhone: z.string().nullable(),
      email: z.string().nullable(),
      textsOn: z.boolean(),
    }),
    language,
    /** The IANA zone the customer's quiet hours and reminders use (FR-TEXT-17). */
    zone: z.string(),
    address: z.object({
      streetId: placeId(), houseNumber, street: addressField(), city: z.string(), zip: addressField(),
      homeType: z.string().nullable(), gettingIn: z.string().nullable(),
    }).meta(addressNamed),
    /** The stored map position (SD-23): the address's on-street point. */
    position: z.object({ lon: z.number(), lat: z.number() }),
    source: z.enum(['import', 'online', 'office']),
    /** For an imported customer, when the real import finished (SPECIFICATIONS FR-DISP-31); else null. */
    importedAt: wireTime.nullable(),
    customerSince: localDate,
    membership: z.object({ since: localDate, renews: localDate, benefitsKey: z.string() }).nullable(),
    notes: z.array(z.object({ id: z.uuid(), authorKind: z.enum(['office', 'technician']), author: z.string(), at: wireTime, text: z.string() })),
    equipment: z.array(equipmentRow),
    upcoming: z.array(z.object({
      jobNumber: z.number().int(),
      day: localDate,
      window: z.object({ start: wireTime, end: wireTime }),
      serviceId: z.string(),
      status: z.enum(['scheduled', 'on_the_way', 'on_site']),
      /** SD-15 timing of today's visit with a technician (F-869); null on another day or with no technician. */
      timing: z.enum(['on_time', 'at_risk', 'late']).nullable(),
      /** The arrival estimate, on the day of the visit only. */
      eta: wireTime.nullable(),
      technician: z.object({ name: z.string(), initials: z.string(), van: z.string().nullable(), skill: z.string() }).nullable(),
    })),
    /** Past visits and done jobs, newest first (SPECIFICATIONS section 6.2). */
    history: z.array(z.object({
      date: localDate,
      service: z.string(),
      serviceId: z.string().nullable(),
      technician: z.string().nullable(),
      /** The old system's visit (an import row) or a job done here. */
      old: z.boolean(),
      jobNumber: z.number().int().nullable(),
      /** What was done (F-670): a done job's work-done lines in their order, or the old system's work-done cell as 1 line; empty when none was recorded. */
      workDone: z.array(z.string()),
    })),
    recentTexts: z.array(z.object({ at: wireTime, kind: z.string(), direction: z.enum(['out', 'in']), status: z.string().nullable() })),
  }),
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', input: { customerId: SAMPLE_ID }, expectStatus: 401 }],
});

/** A US mobile number, 10 digits however it is punctuated (the handler stores E.164). */
const phoneText = z.string().trim().max(30);

export const editCustomer = defineContract({
  id: 'API-36',
  name: 'Edit customer',
  method: 'PATCH',
  path: '/customers/{customerId}',
  request: z.object({
    customerId: z.uuid(),
    name: z.string().trim().min(1).max(120).optional(),
    mobile: phoneText.nullable().optional(),
    streetId: z.uuid().optional(),
    houseNumber: houseNumber.optional(),
    textLanguage: language.optional(),
    textsOn: z.boolean().optional(),
    timeZone: z.string().min(1).max(60).optional(),
    // A membership field is never office-editable (FR-DISP-32): the row accepts it only to answer rule_refused.
    membership: z.unknown().optional(),
  }),
  response: z.object({ id: z.uuid(), name: z.string(), branch: z.string(), zone: z.string() }),
  errors: ['rule_refused'],
  labels: [],
  examples: [{ name: 'signed out', input: { customerId: SAMPLE_ID, name: 'Harold B. Jenkins' }, expectStatus: 401 }],
});

export const searchStreets = defineContract({
  id: 'API-111',
  name: 'Street search',
  method: 'POST',
  path: '/public/street-searches',
  // The text stays out of the URL (NFR-05).
  request: z.object({ query: z.string().trim().min(2).max(100) }),
  response: z.object({
    streets: z.array(z.object({
      streetId: placeId(), name: addressField(), city: z.string(), zip: addressField(), branch: z.string(),
    })).meta(addressNamed),
  }),
  errors: [],
  labels: [],
  examples: [{ name: 'a 1-letter text is refused', input: { query: 'x' }, expectStatus: 422 }],
});

export const createCustomer = defineContract({
  id: 'API-139',
  name: 'Create a customer',
  method: 'POST',
  path: '/customers',
  request: z.object({
    name: z.string().trim().min(1).max(120),
    mobile: phoneText.nullable(),
    streetId: z.uuid(),
    houseNumber,
    textLanguage: language,
    textsOn: z.boolean(),
  }),
  response: z.object({
    id: z.uuid(),
    name: z.string(),
    branch: z.string(),
    zip: addressField(),
    zone: z.string(),
    position: z.object({ lon: z.number(), lat: z.number() }),
  }),
  successStatus: [201],
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', input: { name: 'Lucia Moreno', mobile: null, streetId: SAMPLE_ID, houseNumber: 2310, textLanguage: 'es', textsOn: false }, expectStatus: 401 }],
});

export const customersContracts: ContractRow[] = [searchCustomers, customerDetail, editCustomer, createCustomer, searchStreets];
