// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-DISP-11, FR-DISP-20, FR-IMP-7 (P2-SETUP Acceptance, moved from P2-SHELL by owner ruling c025a9ec)
// The checks ci/setup-stack.sh runs against the Compose stack after a fresh setup, through its proxy:
//   - the top-bar search (API-130, POST /api/v1/searches, as the office) finds job 24825 by "24825", Harold Jenkins's
//     address by its street name, and both O'Briens (Sean O'Brien, Kathleen O'Brien-Miller) by "O'Brien" (FR-DISP-11);
//   - every number a sample Call control dials (customers' mobile and home phones, technicians' phones, branch office
//     numbers; read from the stack's database into the numbers file) is in FR-IMP-7's range (555-0100 to 555-0199 in
//     area 614 or 937) or is a branch office number (FR-DISP-20).
// usage: node ci/setup-stack/check.ts <base url> <session token> <numbers file> <office numbers file> <house|street|city>
// Exit 0 when every check holds; 1 with 1 FAIL line per failed check.
import { readFileSync } from 'node:fs';
import { isMain } from '../is-main.ts';

/** APP_ORIGIN's default (SPECIFICATIONS 11.1): the kernel's Origin check (SD-8) wants it on a write. */
const APP_ORIGIN = 'http://localhost:8080';
const RANGE = /^(\+1(614|937)55501\d\d|\((614|937)\) 555-01\d\d)$/;

interface Found { jobs: { jobNumber: number }[]; customers: { name: string }[]; addresses: { address: string }[] }

export function outsideRange(numbers: readonly string[], offices: ReadonlySet<string>): string[] {
  return numbers.filter((n) => n !== '' && !offices.has(n) && !RANGE.test(n));
}

async function main(argv: string[]): Promise<number> {
  const [base, token, numbersFile, officesFile, address] = argv;
  if (!base || !token || !numbersFile || !officesFile || !address) {
    console.error('usage: check.ts <base url> <session token> <numbers file> <office numbers file> <house|street|city>');
    return 2;
  }
  const fails: string[] = [];
  const search = async (query: string): Promise<Found> => {
    const r = await fetch(`${base}/api/v1/searches`, {
      method: 'POST', body: JSON.stringify({ query, branch: 'columbus' }),
      headers: { 'content-type': 'application/json', origin: APP_ORIGIN, cookie: `bw_session=${token}` },
    });
    if (r.status !== 200) throw new Error(`API-130 answered ${r.status} for a search`);
    return ((await r.json()) as { data: Found }).data;
  };
  const [house, street, city] = address.split('|') as [string, string, string];
  if ((await search('24825')).jobs[0]?.jobNumber !== 24825) fails.push('API-130 does not find job 24825 first by "24825"');
  const byStreet = await search(street);
  if (!byStreet.addresses.some((a) => a.address === `${house} ${street}, ${city}`)) fails.push("API-130 does not find Harold Jenkins's own address by his street name");
  const exact = await search(`${house} ${street}`);
  if (!exact.addresses.some((a) => a.address === `${house} ${street}, ${city}`)) fails.push("API-130 does not find Harold Jenkins's address by house number and street");
  const names = (await search("O'Brien")).customers.map((c) => c.name);
  for (const n of ["Sean O'Brien", "Kathleen O'Brien-Miller"]) if (!names.includes(n)) fails.push(`API-130 does not find ${n} by "O'Brien"`);
  const numbers = readFileSync(numbersFile, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l !== '');
  const offices = new Set(readFileSync(officesFile, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l !== ''));
  if (numbers.length < 10) fails.push(`only ${numbers.length} numbers were read from the stack`);
  const out = outsideRange(numbers, offices);
  if (out.length > 0) fails.push(`${out.length} number(s) a Call control dials are outside FR-IMP-7's range and are no branch office number`);
  for (const f of fails) console.error(`setup-stack: FAIL ${f}`);
  if (fails.length === 0) console.log(`setup-stack: ok (API-130 finds 24825, the street, both O'Briens; ${numbers.length} numbers in range or a branch office's)`);
  return fails.length === 0 ? 0 : 1;
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
