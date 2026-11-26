// SPDX-License-Identifier: AGPL-3.0-or-later
// The parse stage (SPECIFICATIONS section 6.7, SD-24): the old system's export as 3 CSV files in 1 fixed column
// layout (packages/generator/README.md "File layouts"). A file whose header is not exactly its layout, or a row with
// the wrong cell count, stops the run with a named error: the layout is fixed, so a shifted column is never guessed at.
// `exported_at` is copied here, at parse, for import_run.source_exported_at (SD-24); it holds 1 value on every row.
import { CsvError, parseCsv } from './csv.ts';

export const CUSTOMER_COLUMNS = [
  'customer_ref', 'name', 'mobile', 'home_phone', 'email', 'street', 'house_number', 'city', 'zip', 'text_language',
  'time_zone', 'texts_on', 'customer_since', 'home_type', 'getting_in', 'exported_at',
] as const;
export const VISIT_COLUMNS = [
  'visit_ref', 'customer_ref', 'date', 'window_start', 'window_end', 'arrived_at', 'outcome', 'technician', 'service',
  'work_done',
] as const;
export const EQUIPMENT_COLUMNS = [
  'equipment_ref', 'customer_ref', 'street', 'house_number', 'city', 'zip', 'type', 'year', 'location', 'details',
] as const;

export const EXPORT_FILES = ['customers.csv', 'visits.csv', 'equipment.csv'] as const;
export type ExportFile = (typeof EXPORT_FILES)[number];

type Record_<C extends readonly string[]> = { [K in C[number]]: string } & { rowNumber: number };
export type CustomerCsvRow = Record_<typeof CUSTOMER_COLUMNS>;
type VisitCsvRow = Record_<typeof VISIT_COLUMNS>;
type EquipmentCsvRow = Record_<typeof EQUIPMENT_COLUMNS>;

/** The 3 files' text, as read from the export folder. */
export type ExportFiles = Record<ExportFile, string>;

export interface ParsedExport {
  customers: CustomerCsvRow[];
  visits: VisitCsvRow[];
  equipment: EquipmentCsvRow[];
  /** customers.csv `exported_at` (ISO 8601 with offset), or null when the column is empty on every row. */
  exportedAt: string | null;
}

export class LayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LayoutError';
  }
}

function records<C extends readonly string[]>(file: ExportFile, text: string, columns: C): Record_<C>[] {
  let rows;
  try {
    rows = parseCsv(file, text);
  } catch (e) {
    if (e instanceof CsvError) throw new LayoutError(e.message);
    throw e;
  }
  const [header, ...data] = rows;
  if (!header || header.cells.join(',') !== columns.join(',')) {
    throw new LayoutError(`${file}: the header is not the fixed layout (${columns.join(', ')})`);
  }
  return data.map((r) => {
    if (r.cells.length !== columns.length) {
      throw new LayoutError(`${file}: line ${r.line}: ${r.cells.length} cells, the layout has ${columns.length}`);
    }
    const o: Record<string, string | number> = { rowNumber: r.line };
    columns.forEach((c, i) => {
      o[c] = r.cells[i] as string;
    });
    return o as Record_<C>;
  });
}

export function parseExport(files: ExportFiles): ParsedExport {
  const customers = records('customers.csv', files['customers.csv'], CUSTOMER_COLUMNS);
  const visits = records('visits.csv', files['visits.csv'], VISIT_COLUMNS);
  const equipment = records('equipment.csv', files['equipment.csv'], EQUIPMENT_COLUMNS);
  const stamps = new Set(customers.map((c) => c.exported_at).filter((s) => s !== ''));
  if (stamps.size > 1) throw new LayoutError(`customers.csv: exported_at holds ${stamps.size} different values; the export has 1`);
  const exportedAt = stamps.size === 1 ? ([...stamps][0] as string) : null;
  if (exportedAt !== null && Number.isNaN(Date.parse(exportedAt))) {
    throw new LayoutError(`customers.csv: exported_at ${JSON.stringify(exportedAt)} is not an ISO 8601 time`);
  }
  return { customers, visits, equipment, exportedAt };
}
