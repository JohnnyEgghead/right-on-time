// SPDX-License-Identifier: AGPL-3.0-or-later
import en from '../catalog/en.json' with { type: 'json' };
import es from '../catalog/es.json' with { type: 'json' };
import type { Language } from './language.ts';

export const catalogs: Record<Language, Record<string, string>> = { en, es };

export type MessageKey = keyof typeof en;
