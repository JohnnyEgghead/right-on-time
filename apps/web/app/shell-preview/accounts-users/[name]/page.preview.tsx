// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-OFC-43 and its dialogs SCR-OFC-44 to -46 in each state the frame shows, for the look
// comparator (ci/look-values/accounts.pw.test.ts) and the page walkers. Every read is fixed; no call is made.
import { notFound } from 'next/navigation';
import { AREAS, CHANGES, EMPTY, ME, OMAR, SEARCH, TANYA } from '../../../../src/accounts/preview-fixtures.ts';
import { UsersScreen, type DialogState, type UsersScreenProps } from '../../../../src/accounts/UsersScreen.tsx';
import { APP_INFO, CLOCK_RUNNING } from '../../../../src/shell/preview-fixtures.ts';

export const dynamic = 'force-dynamic';

const NADIA = { name: 'Nadia Price', email: 'nprice@brightwater.example', role: 'office' as const, branch: 'columbus' };
const DIALOGS: Record<string, DialogState> = {
  'invite-editing': { kind: 'invite', step: 'editing' },
  'invite-sending': { kind: 'invite', step: 'sending', ...NADIA },
  'invite-sent': {
    kind: 'invite', step: 'sent', ...NADIA,
    sent: { user: { ...TANYA, id: 'u-nadia', name: NADIA.name, email: NADIA.email, status: 'invited', title: null }, employeeNumber: null, emailLink: '/email/preview' },
  },
  'role-choosing': { kind: 'role', step: 'choosing', user: TANYA, pick: 'manager' },
  'role-saving': { kind: 'role', step: 'saving', user: TANYA, pick: 'manager' },
  'off-asking': { kind: 'off', step: 'asking', user: { ...OMAR, status: 'active' } },
  'off-turning': { kind: 'off', step: 'turning', user: { ...OMAR, status: 'active' } },
};

export default async function UsersPreview({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const fixed: UsersScreenProps = { me: ME, areas: AREAS, changes: CHANGES, clock: CLOCK_RUNNING, appInfo: APP_INFO };
  switch (name) {
    case 'success':
      return <UsersScreen {...fixed} search={SEARCH} />;
    case 'loading':
      return <UsersScreen {...fixed} search="loading" />;
    case 'nomatch':
      return <UsersScreen {...fixed} search={EMPTY} filters={{ query: '', role: 'manager', branch: 'springfield', status: 'all', page: 1 }} />;
    case 'error':
      return <UsersScreen {...fixed} search="failed" />;
    default: {
      const dialog = DIALOGS[name];
      if (!dialog) notFound();
      const screen = dialog.kind === 'invite' ? 'SCR-OFC-44' : dialog.kind === 'role' ? 'SCR-OFC-45' : 'SCR-OFC-46';
      return <UsersScreen {...fixed} search={SEARCH} dialog={dialog} previewScreen={screen} />;
    }
  }
}
