// SPDX-License-Identifier: AGPL-3.0-or-later
// Catalog words that must equal their approved kit frame (F-1289): SCR-TEC-08 Route not loaded, DK-113 in mockups/pages/tech-map.html.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { catalogs } from './catalog.ts';

describe('SCR-TEC-08 Route not loaded words', () => {
  // why: F-1289 the error panel draws the approved frame words, title and body, from 2 keys
  it('reads the title and the destination line of the frame in English', () => {
    expect(catalogs.en['tech.dir.notLoaded']).toBe('The route could not load.');
    expect(catalogs.en['tech.dir.notLoadedBody']).toBe('The destination is below.');
  });

  // why: F-1289 the words come from the frame file itself, so a frame redraw that changes them goes red here
  it('finds both English words in the frame file', () => {
    const frame = readFileSync(new URL('../../../mockups/pages/tech-map.html', import.meta.url), 'utf8');
    expect(frame).toContain(`<b>${catalogs.en['tech.dir.notLoaded']}</b>${catalogs.en['tech.dir.notLoadedBody']}`);
  });

  // why: F-1289 Spanish has the body key too
  it('has both keys in Spanish', () => {
    expect(catalogs.es['tech.dir.notLoaded']).toBe('La ruta no se pudo cargar.');
    expect(catalogs.es['tech.dir.notLoadedBody']).toBe('El destino está abajo.');
  });
});
