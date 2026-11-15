// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-OFC-43 Admin: users and roles at `/office/admin/users` (UI-SPECIFICATION 2.3), managers only: the page gate decides
// before this renders (policy SCR-OFC-43, MANAGER). The screen reads API-07, API-149, API-153 and API-154 itself.
import { UsersScreen } from '../../../../src/accounts/UsersScreen.tsx';

export const dynamic = 'force-dynamic';

export default function UsersPage() {
  return <UsersScreen />;
}
