// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-38 New customer and SCR-OFC-39 Edit customer: one form, two dialogs (frames mockups/pages/office-customer-search.html DK-90 and
// office-customer.html DK-91). SCR-OFC-38 is hosted on SCR-OFC-05 and, from P4-NEWJOB, on SCR-OFC-04, so this component takes only
// what differs: the mode, the starting values, and what to do with the saved customer (`onSaved`). The street is picked from the
// bundled street list (API-111) and only a picked street can be saved (FR-DISP-29, FR-BOOK-12, OA-73); the branch, ZIP code and map
// position come from it on the server (SD-23). The mobile number is checked as 10 digits; texts need a mobile number (FR-TEXT-13).
import { createCustomer, editCustomer, searchStreets } from '@bw/api';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../shell/Icon.tsx';
import { useT } from '../shell/intl.tsx';
import {
  EMPTY_FORM, formHasInput, formProblems, textsAllowed, usDigits, type CustomerForm, type FormProblem,
} from './model.ts';
import { Busy, call, Dialog, SelectField, TextField } from './ui.tsx';

export type StreetHit = { streetId: string; name: string; city: string; zip: string; branch: string };

export interface SavedCustomer {
  id: string;
}

export interface CustomerFormDialogProps {
  mode: 'new' | 'edit';
  /** Edit: the customer being edited. */
  customerId?: string;
  initial?: CustomerForm;
  onClose: () => void;
  /** New: called with the created customer; edit: called after the save. */
  onSaved: (customer: SavedCustomer) => void;
  /** Drawn inside its host (the look comparator's tiles). */
  inline?: boolean;
  /** Preview: the dialog alone in a frame named for it. */
  solo?: boolean;
  /** Preview: the frame's fixed state. */
  frozen?: 'saving' | 'no-street-match';
}

const SCREEN = { new: 'SCR-OFC-38', edit: 'SCR-OFC-39' } as const;

export function CustomerFormDialog({ mode, customerId, initial, onClose, onSaved, inline, frozen, solo }: CustomerFormDialogProps) {
  const t = useT();
  const start = initial ?? EMPTY_FORM;
  const [f, setF] = useState<CustomerForm>(start);
  const [shown, setShown] = useState(false);
  const [hits, setHits] = useState<StreetHit[] | null>(null);
  const [streetFailed, setStreetFailed] = useState(false);
  const [saving, setSaving] = useState(frozen === 'saving');
  const [failure, setFailure] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const seq = useRef(0);
  const edit = mode === 'edit';
  const ctl = edit
    ? { name: 'CTL-OFC-39-01', mobile: 'CTL-OFC-39-02', street: 'CTL-OFC-39-03', lang: 'CTL-OFC-39-04', texts: 'CTL-OFC-39-05', save: 'CTL-OFC-39-07', cancel: 'CTL-OFC-39-08' }
    : { name: 'CTL-OFC-38-01', mobile: 'CTL-OFC-38-02', street: 'CTL-OFC-38-03', lang: 'CTL-OFC-38-05', texts: 'CTL-OFC-38-06', save: 'CTL-OFC-38-08', cancel: 'CTL-OFC-38-09' };
  const set = <K extends keyof CustomerForm>(k: K, v: CustomerForm[K]) => setF((p) => ({ ...p, [k]: v }));
  const problems = formProblems(f);
  const noMatch = frozen === 'no-street-match' || (f.street === null && f.streetText.trim().length >= 2 && hits !== null && hits.length === 0);

  // The street list: searched after 2 characters; the newest answer wins.
  useEffect(() => {
    if (f.street !== null || f.streetText.trim().length < 2 || frozen) {
      if (f.streetText.trim().length < 2) setHits(null);
      return;
    }
    const mine = ++seq.current;
    const timer = setTimeout(() => {
      void call(searchStreets, { query: f.streetText.trim() }).then((r) => {
        if (mine !== seq.current) return;
        setStreetFailed(!r.ok);
        setHits(r.ok ? r.data.streets : null);
      });
    }, 150);
    return () => clearTimeout(timer);
  }, [f.street, f.streetText, frozen]);

  const pick = (s: StreetHit) => {
    setF((p) => ({ ...p, street: s, streetText: `${s.name}, ${s.city}, ${s.zip}` }));
    setHits(null);
  };

  const has = textsAllowed(f);
  const changed = edit && (f.name.trim() !== start.name || f.mobile.trim() !== start.mobile || f.street?.streetId !== start.street?.streetId
    || f.houseNumber.trim() !== start.houseNumber || f.textLanguage !== start.textLanguage || (f.textsOn && has) !== (start.textsOn && textsAllowed(start)));
  const canSave = problems.length === 0 && !saving && (edit ? changed : true);

  const msg = (p: FormProblem): string | undefined => {
    if (!shown || !problems.includes(p)) return undefined;
    return p === 'name' ? t('customers.form.nameEmpty') : p === 'mobile' ? t('customers.form.mobileBad') : p === 'street' ? t('customers.form.streetPick') : t('customers.form.houseBad');
  };

  const save = async () => {
    setShown(true);
    if (problems.length > 0 || saving) return;
    setSaving(true);
    setFailure(null);
    const street = f.street as NonNullable<CustomerForm['street']>;
    const mobile = f.mobile.trim() === '' ? null : f.mobile.trim();
    const r = edit
      ? await call(editCustomer, {
        customerId: customerId as string, name: f.name.trim(), mobile, streetId: street.streetId, houseNumber: Number(f.houseNumber.trim()),
        textLanguage: f.textLanguage, textsOn: f.textsOn && has,
      })
      : await call(createCustomer, {
        name: f.name.trim(), mobile, streetId: street.streetId, houseNumber: Number(f.houseNumber.trim()), textLanguage: f.textLanguage, textsOn: f.textsOn && has,
      });
    if (r.ok) {
      onSaved({ id: r.data.id });
      return;
    }
    setSaving(false);
    setFailure(r.code === 'rule_refused' ? t('customers.form.refused') : t('customers.form.failed'));
  };

  const close = () => {
    if (saving) return;
    if (!edit && formHasInput(f) && !asking) setAsking(true);
    else onClose();
  };

  const foot = asking ? (
    <>
      <span className="r1-note bw-cu-ask">{t('customers.new.discard')}</span>
      <button type="button" className="btn" data-ctl={ctl.cancel} onClick={() => setAsking(false)}>{t('customers.new.keep')}</button>
      <button type="button" className="btn primary" data-initial data-ctl={ctl.cancel} onClick={onClose}>{t('customers.new.discardYes')}</button>
    </>
  ) : (
    <>
      <button type="button" className={`btn${saving && edit ? ' dis' : ''}`} aria-disabled={(saving && edit) || undefined} data-ctl={ctl.cancel} onClick={close}>{t('customers.dialog.cancel')}</button>
      {!edit && noMatch ? <span className="r1-note bw-cu-pickfirst">{t('customers.new.pickFirst')}</span> : null}
      {saving ? <Busy label={t('customers.form.saving')} ctl={ctl.save} /> : (
        <button type="submit" form={`cu-form-${mode}`} className={`btn primary${canSave ? '' : ' dis'}`} aria-disabled={!canSave || undefined} data-ctl={ctl.save}>
          {edit ? t('customers.edit.save') : t('customers.new.save')}
        </button>
      )}
    </>
  );

  const list = hits !== null && hits.length > 0 && f.street === null ? (
    <div className="ddl" role="listbox" aria-label={t('customers.form.street')}>
      {hits.map((s) => (
        <div key={s.streetId} role="option" aria-selected="false" tabIndex={0} onClick={() => pick(s)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), pick(s))}>
          {s.name} <small>{s.city}, {s.zip}</small>
        </div>
      ))}
    </div>
  ) : null;
  const streetError = noMatch ? t('customers.form.streetNone', { text: f.streetText.trim() }) : streetFailed ? t('customers.form.streetFailed') : msg('street');

  return (
    <Dialog
      screen={SCREEN[mode]} title={edit ? t('customers.edit.title') : t('customers.new.title')} closeCtl={ctl.cancel} onClose={close} {...(inline ? { inline } : {})} {...(solo ? { hosted: false } : {})}
      foot={foot}
      body={(
        <form id={`cu-form-${mode}`} onSubmit={(e) => (e.preventDefault(), void save())} noValidate>
          <TextField id={`cu-name-${mode}`} ctl={ctl.name} label={t('customers.form.name')} value={f.name} onChange={(v) => set('name', v)} error={msg('name')} disabled={saving} autoComplete="off" initial={!edit} />
          <div className="g2f bw-mt12">
            <TextField id={`cu-mobile-${mode}`} ctl={ctl.mobile} label={t('customers.form.mobile')} value={f.mobile} onChange={(v) => set('mobile', v)} error={msg('mobile')} disabled={saving} inputMode="tel" autoComplete="off" />
            <SelectField
              id={`cu-lang-${mode}`} ctl={ctl.lang} label={t('customers.form.language')} value={f.textLanguage} onChange={(v) => set('textLanguage', v as 'en' | 'es')} disabled={saving}
              options={[{ value: 'en', text: t('customers.language.en') }, { value: 'es', text: t('customers.language.es') }]}
            />
          </div>
          <div className="g2f bw-mt12" {...(edit ? { 'data-ctl': 'CTL-OFC-39-03' } : {})}>
            <TextField
              id={`cu-street-${mode}`} {...(edit ? {} : { ctl: 'CTL-OFC-38-03' })} label={t('customers.form.street')} value={f.streetText}
              onChange={(v) => setF((p) => ({ ...p, streetText: v, street: null }))} error={noMatch || streetFailed ? streetError : (shown && problems.includes('street') && !noMatch ? streetError : undefined)}
              disabled={saving} autoComplete="off" placeholder={t('customers.form.streetPlaceholder')}
            >
              {list}
            </TextField>
            <TextField
              id={`cu-house-${mode}`} {...(edit ? {} : { ctl: 'CTL-OFC-38-04' })} label={t('customers.form.house')} value={f.houseNumber} onChange={(v) => set('houseNumber', v)}
              error={msg('house')} disabled={saving || f.street === null} placeholder={f.street === null ? t('customers.form.housePlaceholder') : undefined} inputMode="numeric"
            />
          </div>
          <div className="row bw-mt12">
            <label className={`ck${has ? '' : ' off'}`} data-ctl={ctl.texts}>
              <input
                type="checkbox" className="bw-cu-cb" checked={f.textsOn} disabled={saving || !has} aria-describedby={has ? undefined : `cu-need-${mode}`}
                onChange={(e) => set('textsOn', e.target.checked)}
              />
              <span className="bx" aria-hidden="true">{f.textsOn ? <Icon name="check" /> : null}</span>
              {t('customers.form.textsOn')}
              {has ? null : <span className="bw-sr" id={`cu-need-${mode}`}>{t('customers.form.textsNeed')}</span>}
            </label>
          </div>
          {edit ? (
            <>
              {!f.textsOn || !has ? <p className="r1-hint">{t('customers.edit.textsOffNote')}</p> : null}
              <p className="r1-hint" data-ctl="CTL-OFC-39-06">{t('customers.edit.membershipNote')}</p>
            </>
          ) : <p className="r1-hint" data-ctl="CTL-OFC-38-07">{t('customers.new.zoneNote')}</p>}
          {failure ? <div className="r1-fmsg" role="alert"><Icon name="alert" />{failure}</div> : null}
        </form>
      )}
    />
  );
}

export { usDigits };
