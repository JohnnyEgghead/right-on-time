// SPDX-License-Identifier: AGPL-3.0-or-later
// The native app's words: the shared catalog (@bw/i18n) through react-intl, no default messages (FR-LANG-3).
import type { MessageKey } from '@bw/i18n/src/catalog.ts';
import { useIntl } from 'react-intl';

export type T = (key: MessageKey, values?: Record<string, string | number>) => string;

export function useT(): T {
  const intl = useIntl();
  return (key, values) => intl.formatMessage({ id: key }, values);
}
