// SPDX-License-Identifier: AGPL-3.0-or-later
// RFC 4180 CSV with \n line ends (SPECIFICATIONS section 6.7): a cell is quoted only when it holds a comma, a quote
// or a line break. The parser is the checks' own reader of the generated files (not the importer's).

function cell(v: string | number): string {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: readonly string[], rows: readonly (readonly (string | number)[])[]): string {
  const out: string[] = [header.map(cell).join(',')];
  for (const r of rows) {
    if (r.length !== header.length) throw new Error(`toCsv: row has ${r.length} cells, header has ${header.length}`);
    out.push(r.map(cell).join(','));
  }
  return out.join('\n') + '\n';
}

/** Parse CSV text into rows of cells (the header is row 0). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur !== '' || row.length > 0) { row.push(cur); rows.push(row); }
  return rows;
}

/** Rows as objects keyed by the header. */
export function readCsvRecords(text: string): Record<string, string>[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}
