// SPDX-License-Identifier: AGPL-3.0-or-later
// Place names the office screens say for an area (F-1652): a neighborhood for the ZIPs the approved Jobs page names one for,
// the street's city otherwise. Pure data.

/** ZIP to neighborhood name: the approved Jobs page (mockups/pages/office-jobs.html) shows Clintonville for 43202 and 43214. */
export const NEIGHBORHOOD_BY_ZIP: Readonly<Record<string, string>> = {
  '43202': 'Clintonville',
  '43214': 'Clintonville',
};

/** The area a list shows for a street: its neighborhood when its ZIP has one, its city otherwise. */
export const areaName = (city: string, zip: string): string => NEIGHBORHOOD_BY_ZIP[zip.trim()] ?? city;

/**
 * The same rule as areaName, as a SQL expression over a street's city and zip columns, for the queries that select the area already
 * named (F-1690: one rule for every response that shows a place name for a job or customer). Built from NEIGHBORHOOD_BY_ZIP, so the
 * two cannot drift; the names are constants, quoted here.
 */
export const areaSql = (cityColumn: string, zipColumn: string): string => {
  const whens = Object.entries(NEIGHBORHOOD_BY_ZIP).map(([zip, name]) => `WHEN '${zip.replace(/'/g, "''")}' THEN '${name.replace(/'/g, "''")}'`);
  return whens.length === 0 ? cityColumn : `(CASE btrim(${zipColumn}) ${whens.join(' ')} ELSE ${cityColumn} END)`;
};
