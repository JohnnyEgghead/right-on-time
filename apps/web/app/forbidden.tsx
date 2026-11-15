// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-SHR-01 No access: rendered with status 403 when a page calls forbidden(), which the shell does only for the error
// code `forbidden` (src/shell/outcome.ts, F-129), never for another code that shares HTTP 403.
import { SharedPage } from '../src/shell/SharedPages.tsx';

export default function Forbidden() {
  return <SharedPage kind="no-access" />;
}
