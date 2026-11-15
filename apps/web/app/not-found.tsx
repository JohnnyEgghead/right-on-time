// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-SHR-02 Page not found: any route answering 404 (an unknown path, or notFound() from a page whose subject is missing).
import { SharedPage } from '../src/shell/SharedPages.tsx';

export default function NotFound() {
  return <SharedPage kind="not-found" />;
}
