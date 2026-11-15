// SPDX-License-Identifier: AGPL-3.0-or-later
// The import's own CSV reader (SPECIFICATIONS section 6.7, SD-24: the parse stage's fixed column layout). RFC 4180:
// a quoted cell may hold commas, doubled quotes and line breaks; rows end in \n (a \r before it is dropped). Strict,
// unlike a spreadsheet: an unterminated quote or a stray quote inside an unquoted cell is a parse error naming the
// line, never a silently shifted row.

export class CsvError extends Error {
  constructor(file: string, line: number, what: string) {
    super(`${file}: line ${line}: ${what}`);
    this.name = 'CsvError';
  }
}

/** 1 parsed row: its cells and the file line it starts on (the header is line 1). */
export interface CsvRow {
  line: number;
  cells: string[];
}

export function parseCsv(file: string, text: string): CsvRow[] {
  const rows: CsvRow[] = [];
  let cells: string[] = [];
  let cur = '';
  let quoted = false;
  let cellStart = true;
  let line = 1;
  let rowLine = 1;
  const endCell = () => {
    cells.push(cur);
    cur = '';
    cellStart = true;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          quoted = false;
          const next = text[i + 1];
          if (next !== undefined && next !== ',' && next !== '\n' && next !== '\r') {
            throw new CsvError(file, line, 'text after a closing quote');
          }
        }
      } else {
        if (ch === '\n') line++;
        cur += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (!cellStart) throw new CsvError(file, line, 'a quote inside an unquoted cell');
      quoted = true;
      cellStart = false;
    } else if (ch === ',') {
      endCell();
    } else if (ch === '\n') {
      endCell();
      rows.push({ line: rowLine, cells });
      cells = [];
      line++;
      rowLine = line;
    } else if (ch === '\r' && text[i + 1] === '\n') {
      // CRLF: the \n ends the row.
    } else {
      cur += ch;
      cellStart = false;
    }
  }
  if (quoted) throw new CsvError(file, rowLine, 'unterminated quoted cell');
  if (cur !== '' || cells.length > 0) {
    endCell();
    rows.push({ line: rowLine, cells });
  }
  return rows;
}
