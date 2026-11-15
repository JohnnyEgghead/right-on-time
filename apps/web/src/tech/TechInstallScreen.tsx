// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-TEC-11 Install the app (web only) at /tech/install (UI-SPECIFICATION 2.3; DK-115 mockups/pages/r1-techweb-install.html; NFR-09, OA-19):
// the first time the web technician app opens in a phone browser tab, a short page with the steps for the visitor's browser, the browser's own
// install prompt where it offers one, and Continue in the browser, which opens the app and stops this page showing in this browser. The page is
// public (CMP-14 with the full brand name and no phone number: no branch applies); the access code gate in front of it is the page gate's.
import '../shell/css/phone.ts';
// DK-115 loads the single-draft slice (DK-47: the message boxes) between the phone slices and its own sheet.
import '../../styles/kit/kit.r1-single.css';
import '../../styles/page-tech-install.css';
import '../../styles/app/tech.css';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, Mark } from '../shell/Icon.tsx';
import { useT } from '../shell/intl.tsx';
import { LanguageSwitch } from '../shell/LanguageSwitch.tsx';
import { createReader } from '../shell/reads.ts';
import type { AppInfo } from '../shell/Footer.tsx';
import { Screen } from '../shell/Surface.tsx';
import { installKind, installSeen, markInstallSeen, type InstallKind } from './install.ts';

/** The prompt event Chrome on Android fires (not in the DOM typings). */
interface InstallPrompt extends Event {
  prompt(): Promise<void>;
}

const bold = (chunks: ReactNode[]) => <b>{chunks}</b>;

function Steps({ kind }: { kind: InstallKind }) {
  const t = useT();
  if (kind === 'iphone') {
    return (
      <ol className="steps11" data-ctl="CTL-TEC-11-01">
        <li><span className="n">1</span><span className="gl"><Icon name="arrowUp" /></span><span>{t.rich('tech.install.iphone.1', { b: bold })}</span></li>
        <li><span className="n">2</span><span className="gl"><Icon name="plus" /></span><span>{t.rich('tech.install.iphone.2', { b: bold })}</span></li>
        <li><span className="n">3</span><span className="gl home"><Icon name="home" /></span><span>{t.rich('tech.install.iphone.3', { b: bold })}</span></li>
      </ol>
    );
  }
  if (kind === 'other') {
    return (
      <div className="infobox2" data-ctl="CTL-TEC-11-01">
        <Icon name="info" />
        <span>{t('tech.install.other')}</span>
      </div>
    );
  }
  return (
    <ol className="steps11" data-ctl="CTL-TEC-11-01">
      <li><span className="n">1</span><span>{t.rich(kind === 'android-prompt' ? 'tech.install.android.prompt' : 'tech.install.android.menu', { b: bold })}</span></li>
    </ol>
  );
}

/** CMP-04 as the frame draws it at this width (.pfoot): the source link, the sample-data line and the demo marker, from API-02. */
function Foot({ info }: { info: AppInfo | null }) {
  const t = useT();
  return (
    <div className="pfoot" data-cmp="CMP-04">
      {info ? <><a href={info.sourceUrl} data-ctl="CTL-CMP-04-01">{t('shell.footer.source')} {info.sourceCommit.slice(0, 7)}</a> - </> : null}
      <span data-ctl="CTL-CMP-04-02">{t('shell.footer.sample')}</span>
      {info?.demoMode ? <> <span className="demo" data-ctl="CTL-CMP-04-03">{t('shell.footer.demo')}</span></> : null}
    </div>
  );
}

export function TechInstallScreen({ fixedKind, fixedInfo }: { fixedKind?: InstallKind; fixedInfo?: AppInfo | null }) {
  const t = useT();
  const [kind, setKind] = useState<InstallKind | null>(fixedKind ?? null);
  const [info, setInfo] = useState<AppInfo | null>(fixedInfo ?? null);
  const prompt = useRef<InstallPrompt | null>(null);

  useEffect(() => {
    if (fixedKind) return;
    // CTL-TEC-11-03 stopped this page showing in this browser: the app opens instead.
    if (installSeen(window.localStorage)) {
      window.location.replace('/tech');
      return;
    }
    const ua = navigator.userAgent;
    setKind(installKind(ua, false));
    const offered = (e: Event) => {
      e.preventDefault();
      prompt.current = e as InstallPrompt;
      setKind(installKind(ua, true));
    };
    window.addEventListener('beforeinstallprompt', offered);
    void createReader({ baseUrl: window.location.origin }).read<AppInfo>('API-02').then((r) => {
      if (r.ok) setInfo(r.data);
    });
    return () => window.removeEventListener('beforeinstallprompt', offered);
  }, [fixedKind]);

  const install = () => {
    // CTL-TEC-11-02: the browser's own prompt; a dismissed prompt changes nothing.
    void prompt.current?.prompt().catch(() => undefined);
  };
  const next = () => {
    markInstallSeen(window.localStorage);
    window.location.assign('/tech');
  };

  return (
    <Screen screen="SCR-TEC-11" surface="SURF-TWA" phone live footer={false} {...(fixedKind ? { reader: false as const, clock: null } : {})}>
      <div className="screen inst bw-tech bw-tech-install">
        <div className="ph11">
          <div className="top11" data-ctl="CTL-CMP-14-01" data-cmp="CMP-14">
            <span className="brand">
              <Mark />
              <span className="word">{t('brand.name')}<small>{t('brand.trade')}</small></span>
            </span>
            <span className="grow" />
            <LanguageSwitch />
          </div>
        </div>
        <div className="body11">
          <h1>{t('tech.install.title')}</h1>
          <p className="lead">{t('tech.install.lead')}</p>
          {kind ? <Steps kind={kind} /> : null}
          {kind === 'android-prompt' ? (
            <a className="btn primary cont" role="button" tabIndex={0} data-ctl="CTL-TEC-11-02" onClick={install}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); install(); } }}>
              <Icon name="download" />
              {t('tech.install.install')}
            </a>
          ) : null}
          <a className="btn cont" role="button" tabIndex={0} data-ctl="CTL-TEC-11-03" onClick={next}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); next(); } }}>
            {t('tech.install.continue')}
          </a>
          {kind === 'iphone' ? <p className="why11">{t('tech.install.why')}</p> : null}
          <Foot info={info} />
        </div>
      </div>
    </Screen>
  );
}
