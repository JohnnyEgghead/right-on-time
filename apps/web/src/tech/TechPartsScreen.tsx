// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-TEC-16 Parts (UI-SPECIFICATION 2.3; DK-116 mockups/pages/r1-techweb-parts.html; FR-TECH-10, FR-BILL-3): a read-only search of the
// parts list kept on the phone (API-107, read with signal and kept by data.ts), by name or code, working with no signal. Nothing here edits a
// part or counts stock. The frame draws its tab bar as anchors in a nav element (DK-116), so this screen asks the shell for that markup.
import '../shell/css/phone.ts';
import '../../styles/page-tech-parts.css';
import { useEffect, useId, useRef, useState } from 'react';
import { Icon } from '../shell/Icon.tsx';
import { useT } from '../shell/intl.tsx';
import { useTechData, type TechData } from './data.ts';
import type { OutboxState } from './engine.ts';
import { priceText, searchParts } from './model.ts';
import { NoSignalCard, WaitingCount } from './SyncStrip.tsx';
import { TechAppFrame } from './TechAppFrame.tsx';
import { useOutbox } from './useOutbox.ts';
import { partsPhase } from './view-model.ts';

export interface TechPartsScreenProps {
  fixedData?: TechData;
  fixedOutbox?: OutboxState;
  /** A preview's typed search. */
  fixedQuery?: string;
}

export function TechPartsScreen({ fixedData, fixedOutbox, fixedQuery }: TechPartsScreenProps) {
  const t = useT();
  const id = useId();
  const data = useTechData(fixedData);
  const outbox = useOutbox(fixedOutbox);
  const [query, setQuery] = useState(fixedQuery ?? '');
  // F-1062 (shell/early-form.ts rule 1): the field is uncontrolled, so text typed while the page hydrates stays; the state takes it once hydrated.
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const v = field.current?.value ?? '';
    setQuery((q) => (v !== q ? v : q));
  }, []);
  const clear = () => {
    if (field.current) field.current.value = '';
    setQuery('');
  };
  const parts = data.parts?.data ?? null;
  const phase = partsPhase(parts, query);
  const found = parts ? searchParts(parts, query) : { shown: [], matched: 0 };
  const fixed = fixedOutbox ? { fixed: fixedOutbox } : {};

  // Reading the phone (rule 12, F-1434): until the page has read the kept copy, a skeleton, never No copy yet.
  const reading = data.reading === true;

  return (
    <TechAppFrame
      screen="SCR-TEC-16"
      tab="parts"
      tabMarkup="anchors"
      {...(fixedData ? { data: fixedData } : {})}
      {...(fixedOutbox ? { fixed: fixedOutbox, reader: false as const, clock: null } : {})}
      header={(
        <div className="apphead">
          <div className="r">
            <div>
              <h1>{t('tech.tab.parts')}</h1>
              <div className="d">{t('tech.parts.sub')}</div>
            </div>
            <WaitingCount variant="job" {...fixed} />
          </div>
        </div>
      )}
    >
      <div className="list16">
        {!outbox.online ? <div className="bw-tech-pad"><NoSignalCard {...fixed} /></div> : null}
        {phase === 'nocopy' && !reading ? (
          <div className="emp" data-ctl="CTL-TEC-16-01">
            <Icon name="cloud" />
            <span>{t('tech.parts.noCopy')}</span>
          </div>
        ) : (
          <>
            <label className="lbl16" htmlFor={id}>{t('tech.parts.find')}</label>
            <div className={(reading ? query === '' : phase === 'empty') ? 'srch idle' : 'srch'} data-ctl="CTL-TEC-16-01">
              <Icon name="search" />
              <input
                id={id}
                className="v"
                type="text"
                inputMode="search"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                translate="no"
                placeholder={t('tech.parts.placeholder')}
                ref={field}
                defaultValue={fixedQuery ?? ''}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query !== '' ? (
                <a className="clr" role="button" tabIndex={0} aria-label={t('tech.parts.clear')} data-ctl="CTL-TEC-16-03" onClick={clear}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); clear(); } }}>
                  <Icon name="plus" />
                </a>
              ) : null}
            </div>
            {/* Kit 0.12 (57520d6c): the search field, and skeleton rows in place of the count hint and the list (the list is in the kept copy). */}
            {reading ? (
              <div className="res bw-mt8" data-ctl="CTL-TEC-16-02" aria-busy="true">
                {[1, 2, 3].map((k) => <div className="pr" key={k}><span className="tx"><span className="r1-skel bw-skel-70" /><span className="r1-skel bw-skel-35" /></span></div>)}
              </div>
            ) : null}
            {!reading && phase === 'empty' ? (
              <div className="emp"><Icon name="box" /><span>{t('tech.parts.empty', { total: parts?.length ?? 0 })}</span></div>
            ) : null}
            {!reading && phase === 'nomatch' ? (
              <div className="emp" data-ctl="CTL-TEC-16-02"><Icon name="search" /><span>{t('tech.parts.noMatch', { q: query.trim() })}</span></div>
            ) : null}
            {!reading && phase === 'results' ? (
              <>
                <div className="cnt">{t('tech.parts.count', { shown: found.matched, total: parts?.length ?? 0 })}</div>
                <div className="res" data-ctl="CTL-TEC-16-02">
                  {found.shown.map((p) => (
                    <div className="pr" key={p.partId}>
                      <span className="tx"><b>{p.name}</b><code translate="no">{p.code}</code></span>
                      <span className="pz">{priceText(p.priceCents)}</span>
                    </div>
                  ))}
                </div>
                <div className="ro"><Icon name="cloud" /><span>{t('tech.parts.kept')}</span></div>
              </>
            ) : null}
          </>
        )}
      </div>
    </TechAppFrame>
  );
}
