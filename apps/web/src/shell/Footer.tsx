// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// CMP-04 footer (DK-27, markup DK-79): Source link to the public repo's commit of the running release (CTL-CMP-04-01, FR-DIST-3; the repo itself when the commit is unknown), the sample
// data notice (CTL-CMP-04-02, static catalog text) and the demo mode marker (CTL-CMP-04-03). The link and the marker come
// from API-02: while it fails or has not landed, the link is hidden and the marker is not shown.
import { useEffect, useState } from 'react';
import { Icon } from './Icon.tsx';
import { useT } from './intl.tsx';
import { createReader, type Reader } from './reads.ts';

export interface AppInfo {
  demoMode: boolean;
  accessCodeOn?: boolean;
  sourceUrl: string;
  sourceCommit: string;
}

export function Footer({ info: given, reader, demoMarker = true }: { info?: AppInfo | null; reader?: Reader | false; demoMarker?: boolean }) {
  const t = useT();
  const [info, setInfo] = useState<AppInfo | null>(given ?? null);
  useEffect(() => {
    if (given || reader === false) return;
    void (reader ?? createReader({ baseUrl: window.location.origin })).read<AppInfo>('API-02').then((r) => {
      if (r.ok) setInfo(r.data);
    });
  }, [given, reader]);
  return (
    <footer className="r1-foot" data-cmp="CMP-04">
      {info ? (
        <a href={info.sourceUrl} data-ctl="CTL-CMP-04-01">
          <Icon name="globe" />
          {t('shell.footer.source')} <code>{info.sourceCommit.slice(0, 7)}</code>
        </a>
      ) : null}
      <span data-ctl="CTL-CMP-04-02">{t('shell.footer.sample')}</span>
      {demoMarker && info?.demoMode ? (
        <span className="demo" data-ctl="CTL-CMP-04-03">
          {t('shell.footer.demo')}
        </span>
      ) : null}
    </footer>
  );
}
