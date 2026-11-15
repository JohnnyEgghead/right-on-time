// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-43 Admin: users and roles, with its dialogs SCR-OFC-44 Invite user, SCR-OFC-45 Change role and SCR-OFC-46 Turn a
// user off (frame mockups/pages/admin-users.html, DK-101; FR-AUTH-12, FR-AUTH-8, UC-18). Managers only (the page gate and
// every call refuse anyone else). Reads API-149 (the users, by the filters), API-153 (what each role can see, from the
// policy table the server enforces) and API-154 (recent changes); writes API-150, API-151, API-152 and API-170, after which
// the table and the changes re-read and CMP-11 names the change. The invite's one-time link (CTL-OFC-44-06) is shown to
// the inviting manager once and opens the invite email in a new tab.
import { whoAmI } from '@bw/api';
import type { MessageKey } from '@bw/i18n';
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useAnnounce } from '../shell/Announcer.tsx';
import { BRANCHES, branchById } from '../shell/branches.ts';
import type { ClockAnswer } from '../shell/clock.ts';
import type { AppInfo } from '../shell/Footer.tsx';
import { AdminFrame } from '../shell/Frames.tsx';
import { Icon } from '../shell/Icon.tsx';
import type { IconName } from '../shell/icon-paths.ts';
import { useModalFocus } from '../shell/modal-focus.ts';
import { useT, type ClientT } from '../shell/intl.tsx';
import type { Me } from '../shell/OfficeTopBar.tsx';
import { ErrorPanel } from '../shell/Panels.tsx';
import {
  callRow, dayText, initialsOf, rows, whenText, type InviteAnswer, type RoleAreas, type UserChange, type UserItem, type UserSearch,
} from './api.ts';
// The page's own rules load after the kit slices its frame module imports, as the frame page orders its sheets.
import '../../styles/page-admin-users.css';
import '../../styles/app/accounts.css';

type Role = UserItem['role'];
type Status = UserItem['status'];
export interface Filters { query: string; role: 'all' | Role; branch: string; status: 'all' | Status; page: number }
export const NO_FILTERS: Filters = { query: '', role: 'all', branch: 'all', status: 'all', page: 1 };

export type DialogState =
  | { kind: 'invite'; step: 'editing' | 'sending' | 'sent'; name?: string; email?: string; role?: Role; branch?: string; sent?: InviteAnswer }
  | { kind: 'role'; step: 'choosing' | 'saving'; user: UserItem; pick?: Role }
  | { kind: 'off'; step: 'asking' | 'turning'; user: UserItem };

export interface UsersScreenProps {
  /** Preview states (the harness build): every read answered and fixed, no call made. */
  me?: Me;
  search?: UserSearch | 'loading' | 'failed';
  areas?: RoleAreas | 'failed';
  changes?: UserChange[] | 'failed';
  filters?: Filters;
  dialog?: DialogState | null;
  /** Preview of an open dialog: the screen root carries the dialog's own screen ID, so the walkers open it on its host page. */
  previewScreen?: 'SCR-OFC-44' | 'SCR-OFC-45' | 'SCR-OFC-46';
  clock?: ClockAnswer | null;
  appInfo?: AppInfo | null;
}

const ROLE_ORDER: Role[] = ['office', 'manager', 'technician'];
const ROLE_CHIP: Record<Role, { cls: string; icon: IconName }> = {
  manager: { cls: 'mgr', icon: 'star' }, office: { cls: 'office', icon: 'grid' }, technician: { cls: 'tech', icon: 'truck' },
};
const STATUS_CHIP: Record<Status, { cls: string; key: MessageKey }> = {
  active: { cls: 'site', key: 'accounts.status.active' }, invited: { cls: 'inv', key: 'accounts.status.invited' }, turned_off: { cls: 'off', key: 'accounts.status.turnedOff' },
};
const SEARCH_DEBOUNCE_MS = 250;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The avatar color class (the frame's colors, styles/app/accounts.css): the signed-in manager, others by role, a user who is not Active. */
function avatarClass(u: UserItem, meId: string | undefined): string {
  if (u.id === meId) return 'bw-av-you';
  if (u.status !== 'active') return 'bw-av-off';
  return u.role === 'manager' ? 'bw-av-mgr' : u.role === 'office' ? 'bw-av-office' : 'bw-av-tech';
}

function RoleChip({ role }: { role: Role }) {
  const t = useT();
  const c = ROLE_CHIP[role];
  return (
    <span className={`rl ${c.cls}`}>
      <Icon name={c.icon} />
      {t(`shell.role.${role}`)}
    </span>
  );
}

function StatusChip({ status }: { status: Status }) {
  const t = useT();
  return (
    <span className={`chip ${STATUS_CHIP[status].cls}`} data-cmp="CMP-06">
      <span className="dot" aria-hidden="true" />
      {t(STATUS_CHIP[status].key)}
    </span>
  );
}

const jobLine = (u: UserItem, t: ClientT): string | null => {
  if (u.title) return u.title;
  if (u.role === 'technician' && u.van) {
    const skill = u.primarySkill ? t(`accounts.skill.${u.primarySkill}` as MessageKey) : null;
    return skill ? t('accounts.users.vanSkill', { van: u.van, skill }) : t('accounts.users.van', { van: u.van });
  }
  return null;
};

function signInLines(u: UserItem, t: ClientT): [string, string | null] {
  const last = u.lastSignInAt ? whenText(u.lastSignInAt, t.lang, t) : t('accounts.users.notYet');
  if (u.status === 'turned_off') return [last, u.statusSince ? t('accounts.users.offSince', { day: dayText(u.statusSince, t) }) : t('accounts.status.turnedOff')];
  if (u.status === 'invited') return [last, u.statusSince ? t('accounts.users.inviteSent', { day: dayText(u.statusSince, t) }) : null];
  const where = u.lastSignInApp === null ? null : u.lastSignInApp === 'office' ? t('accounts.users.whereOffice') : t('accounts.users.wherePhone');
  return [last, where];
}

export function UsersScreen(p: UsersScreenProps) {
  const t = useT();
  const announce = useAnnounce();
  const fixed = p.search !== undefined;
  const [meId, setMeId] = useState<string | undefined>(p.me?.userId);
  const [filters, setFilters] = useState<Filters>(p.filters ?? NO_FILTERS);
  const [typed, setTyped] = useState(filters.query);
  const [search, setSearch] = useState<UserSearch | 'loading' | 'failed'>(p.search ?? 'loading');
  const [areas, setAreas] = useState<RoleAreas | 'failed' | null>(p.areas ?? null);
  const [changes, setChanges] = useState<UserChange[] | 'failed' | null>(p.changes ?? null);
  const [dialog, setDialog] = useState<DialogState | null>(p.dialog ?? null);
  const [rowError, setRowError] = useState<string | null>(null);
  const latest = useRef(0);

  const readUsers = useCallback(async (f: Filters) => {
    const n = ++latest.current;
    const r = await callRow(rows.searchUsers, { ...f });
    if (n !== latest.current) return;
    setSearch(r.ok ? r.data : 'failed');
  }, []);
  const readChanges = useCallback(async () => {
    const r = await callRow(rows.userChanges, { limit: 10 });
    setChanges(r.ok ? r.data.changes : 'failed');
  }, []);
  const readAreas = useCallback(async () => {
    const r = await callRow(rows.roleAccess, {});
    setAreas(r.ok ? r.data.areas : 'failed');
  }, []);

  useEffect(() => {
    if (fixed) return;
    void callRow(whoAmI, {}).then((r) => r.ok && setMeId(r.data.userId));
    void readAreas();
    void readChanges();
  }, [fixed, readAreas, readChanges]);
  useEffect(() => {
    if (!fixed) void readUsers(filters);
  }, [fixed, filters, readUsers]);
  // CTL-OFC-43-02: the typed text filters after a short pause, as the top bar's search does.
  useEffect(() => {
    if (fixed || typed === filters.query) return;
    const h = window.setTimeout(() => setFilters((f) => ({ ...f, query: typed, page: 1 })), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(h);
  }, [fixed, typed, filters.query]);

  const changed = async (text: string) => {
    setDialog(null);
    announce(text);
    await Promise.all([readUsers(filters), readChanges()]);
  };

  const turnOn = async (u: UserItem) => {
    setRowError(null);
    const r = await callRow(rows.turnUserOn, { userId: u.id });
    if (r.ok) return changed(t('accounts.users.turnedOn', { name: u.name }));
    if (r.code === 'not_found') return readUsers(filters);
    setRowError(r.code === 'rule_refused' ? t('accounts.users.refused') : t('accounts.users.actionFailed'));
  };

  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch, page: patch.page ?? 1 }));
  const s = typeof search === 'object' ? search : null;

  return (
    <AdminFrame
      screen={p.previewScreen ?? 'SCR-OFC-43'} currentPath="/office/admin/users"
      {...(p.me ? { me: p.me } : {})} {...(p.clock !== undefined ? { clock: p.clock, reader: false as const } : {})} {...(p.appInfo !== undefined ? { appInfo: p.appInfo } : {})}
    >
      <div className="ah">
        <div>
          <h1>{t('accounts.users.title')}</h1>
          <p>{t('accounts.users.lead')}</p>
        </div>
        <div className="acts">
          <button type="button" className="btn primary" data-ctl="CTL-OFC-43-01" onClick={() => setDialog({ kind: 'invite', step: 'editing' })}>
            <Icon name="plus" />
            {t('accounts.users.invite')}
          </button>
        </div>
      </div>

      <div className="body bw-users-body">
        <section className="panel listp" aria-labelledby="users-h">
          <h2 id="users-h" className="bw-sr">{t('accounts.users.listTitle')}</h2>
          <div className="fbar">
            <label className="fsel find" data-ctl="CTL-OFC-43-02">
              <Icon name="search" />
              <input
                className="bw-fsel-text" type="search" value={typed} placeholder={t('accounts.users.find')} aria-label={t('accounts.users.find')}
                onChange={(e) => setTyped(e.target.value)}
              />
            </label>
            <FilterSelect ctl="CTL-OFC-43-03" label={t('accounts.users.role')} value={filters.role} onChange={(v) => set({ role: v as Filters['role'] })}
              options={[['all', t('accounts.users.all')], ['manager', t('shell.role.manager')], ['office', t('shell.role.office')], ['technician', t('shell.role.technician')]]} />
            <FilterSelect ctl="CTL-OFC-43-04" label={t('accounts.users.branch')} value={filters.branch} onChange={(v) => set({ branch: v })}
              options={[['all', t('accounts.users.all')], ...BRANCHES.map((b): [string, string] => [b.id, b.name])]} />
            <FilterSelect ctl="CTL-OFC-43-05" label={t('accounts.users.status')} value={filters.status} onChange={(v) => set({ status: v as Filters['status'] })}
              options={[['all', t('accounts.users.all')], ['active', t('accounts.status.active')], ['invited', t('accounts.status.invited')], ['turned_off', t('accounts.status.turnedOff')]]} />
            {s ? <span className="cnt"><b>{t('accounts.users.activePeople', { n: s.counts.byStatus.active })}</b></span> : null}
          </div>
          {rowError ? <div className="r1-fmsg bw-rowerr" role="alert"><Icon name="alert" />{rowError}</div> : null}
          {search === 'loading' ? (
            <div className="bw-skel-pad" aria-busy="true">
              {['bw-w-30', '', '', '', '', ''].map((w, i) => <span key={i} className={`r1-skel ${w}`.trim()} />)}
            </div>
          ) : search === 'failed' ? (
            <div className="bw-skel-pad">
              <ErrorPanel title={t('accounts.users.failed')} hint={t('accounts.users.failedHint')} onRetry={() => readUsers(filters)} />
            </div>
          ) : s && s.users.length === 0 ? (
            <div className="bw-skel-pad"><p className="r1-note">{t('accounts.users.noMatch')}</p></div>
          ) : s ? (
            <div className="bw-tablewrap">
              <table className="u" data-ctl="CTL-OFC-43-06">
                <colgroup><col className="bw-c178" /><col className="bw-c112" /><col className="bw-c84" /><col /><col className="bw-c100" /><col className="bw-c170" /></colgroup>
                <thead>
                  <tr>
                    <th scope="col">{t('accounts.users.person')}</th><th scope="col">{t('accounts.users.role')}</th><th scope="col">{t('accounts.users.branch')}</th>
                    <th scope="col">{t('accounts.users.lastSignIn')}</th><th scope="col">{t('accounts.users.status')}</th><th scope="col"><span className="bw-sr">{t('accounts.users.actions')}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {s.users.map((u) => {
                    const [last, where] = signInLines(u, t);
                    const job = jobLine(u, t);
                    return (
                      <tr key={u.id}>
                        <td>
                          <span className="who">
                            <span className={`av ${avatarClass(u, meId)}`} aria-hidden="true">{initialsOf(u.name)}</span>
                            <span className="bw-min0">
                              <b translate="no">{u.name}</b>
                              {job ? <small className="jt" data-ctl="CTL-OFC-43-14">{job}</small> : null}
                              <small translate="no">{u.email}</small>
                            </span>
                          </span>
                        </td>
                        <td><RoleChip role={u.role} /></td>
                        <td translate="no">{branchById(u.branch).id === u.branch ? branchById(u.branch).name : u.branch}</td>
                        <td className="when">{last}{where ? <small data-ctl="CTL-OFC-43-15">{where}</small> : null}</td>
                        <td><StatusChip status={u.status} /></td>
                        <td className="ra">
                          {u.id === meId ? (
                            <span className="you">{t('accounts.users.you')}</span>
                          ) : u.status === 'turned_off' ? (
                            <button type="button" className="btn sm" data-ctl="CTL-OFC-43-13" onClick={() => void turnOn(u)}>{t('accounts.users.turnOn')}</button>
                          ) : (
                            <>
                              <button type="button" className="btn sm" data-ctl="CTL-OFC-43-07" aria-label={t('accounts.users.changeRoleOf', { name: u.name })} onClick={() => setDialog({ kind: 'role', step: 'choosing', user: u })}>{t('accounts.users.changeRole')}</button>
                              <button type="button" className="btn sm" data-ctl="CTL-OFC-43-08" aria-label={t('accounts.users.turnOffOf', { name: u.name })} onClick={() => setDialog({ kind: 'off', step: 'asking', user: u })}>{t('accounts.users.turnOff')}</button>
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
          {s ? (
            <div className="foot">
              <span data-ctl="CTL-OFC-43-10">
                {t('accounts.users.count', { shown: s.users.length, total: s.total, managers: s.counts.active.manager, office: s.counts.active.office, technicians: s.counts.active.technician })}
              </span>
              {s.pages > 1 ? (
                <span className="pg" data-ctl="CTL-OFC-43-09">
                  <button type="button" className={`btn sm${filters.page <= 1 ? ' dis' : ''}`} aria-disabled={filters.page <= 1 || undefined} onClick={() => filters.page > 1 && set({ page: filters.page - 1 })}>
                    <Icon name="chevLeft" />{t('accounts.users.previous')}
                  </button>
                  <button type="button" className={`btn sm${filters.page >= s.pages ? ' dis' : ''}`} aria-disabled={filters.page >= s.pages || undefined} onClick={() => filters.page < s.pages && set({ page: filters.page + 1 })}>
                    {t('accounts.users.next')}<Icon name="chevRight" />
                  </button>
                </span>
              ) : null}
            </div>
          ) : null}
        </section>

        <section className="panel rolep" aria-labelledby="roles-h">
          <div className="ph"><h3 id="roles-h">{t('accounts.roles.title')}</h3></div>
          {areas === 'failed' ? (
            <div className="bw-skel-pad"><ErrorPanel title={t('accounts.roles.failed')} hint={t('accounts.users.failedHint')} onRetry={readAreas} /></div>
          ) : (
            <table className="m" data-ctl="CTL-OFC-43-11">
              <thead>
                <tr>
                  <th scope="col">{t('accounts.roles.area')}</th>
                  <th scope="col"><span className="rl office">{t('shell.role.office')}</span></th>
                  <th scope="col"><span className="rl tech">{t('shell.role.technician')}</span></th>
                  <th scope="col"><span className="rl mgr">{t('shell.role.manager')}</span></th>
                </tr>
              </thead>
              <tbody>
                {(areas ?? []).map((a) => (
                  <tr key={a.area}>
                    <td>{t(`accounts.roles.area.${a.area}` as MessageKey)}</td>
                    {(['office', 'technician', 'manager'] as const).map((r) => (
                      <td key={r}>{a[r] ? <span className="y"><Icon name="check" />{t('accounts.roles.yes')}</span> : <span className="n"><Icon name="lock" />{t('accounts.roles.no')}</span>}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="callout" data-ctl="CTL-OFC-43-16"><Icon name="lock" /><div><b>{t('accounts.roles.noteTechTitle')}</b> {t('accounts.roles.noteTech')}</div></div>
          <div className="callout info" data-ctl="CTL-OFC-43-16"><Icon name="info" /><div>{t('accounts.roles.noteCustomers')}</div></div>
          <div className="ph bw-ph-gap"><h3>{t('accounts.changes.title')}</h3></div>
          {changes === 'failed' ? (
            <div className="bw-skel-pad"><ErrorPanel title={t('accounts.changes.failed')} hint={t('accounts.users.failedHint')} onRetry={readChanges} /></div>
          ) : (
            <div className="chg" data-ctl="CTL-OFC-43-12">
              {changes && changes.length === 0 ? <div>{t('accounts.changes.none')}</div> : null}
              {(changes ?? []).map((c, i) => <ChangeLine key={i} c={c} />)}
            </div>
          )}
        </section>
      </div>
      {dialog?.kind === 'invite' ? <InviteDialog d={dialog} setD={setDialog} onSent={() => void Promise.all([readUsers(filters), readChanges()])} /> : null}
      {dialog?.kind === 'role' ? <RoleDialog d={dialog} setD={setDialog} onDone={changed} /> : null}
      {dialog?.kind === 'off' ? <OffDialog d={dialog} setD={setDialog} onDone={changed} /> : null}
    </AdminFrame>
  );
}

function FilterSelect({ ctl, label, value, options, onChange }: { ctl: string; label: string; value: string; options: [string, string][]; onChange: (v: string) => void }) {
  const shown = options.find((o) => o[0] === value)?.[1] ?? options[0]![1];
  return (
    <label className="fsel" data-ctl={ctl}>
      <span className="k">{label}</span>
      <b>{shown}</b>
      <Icon name="chevDown" />
      <select className="bw-fsel-native" value={value} aria-label={label} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}

function ChangeLine({ c }: { c: UserChange }) {
  const t = useT();
  const branch = branchById(c.branch).id === c.branch ? branchById(c.branch).name : c.branch;
  const what = {
    invited: t('accounts.changes.invited', { role: t(`shell.role.${c.role}`), branch }),
    role_set: t('accounts.changes.roleSet', { role: t(`shell.role.${c.role}`) }),
    turned_off: t('accounts.changes.turnedOff'),
    turned_back_on: t('accounts.changes.turnedOn'),
  }[c.what];
  const by = c.byName ?? t('accounts.changes.setup');
  return (
    <div>
      <b translate="no">{c.userName}</b> {what}
      <small>{t('accounts.changes.byAt', { by, at: whenText(c.at, t.lang, t) })}</small>
    </div>
  );
}

// ---------- the dialogs (DK-34) ----------

const CLOSE_PATH = '<path d="M6 6l12 12M18 6L6 18"/>';

function Dialog({ title, closeCtl, onClose, children, foot, initial }: { title: string; closeCtl: string; onClose: () => void; children: ReactNode; foot: ReactNode; initial?: string }) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  // The first focus goes to the dialog's own initial control; the Tab ring and the focus return are useModalFocus's (F-1464), whose effect runs after this one.
  useEffect(() => {
    box.current?.querySelector<HTMLElement>(initial ?? 'input, button.btn')?.focus();
  }, [initial]);
  useModalFocus(box);
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };
  return (
    <div className="r1-scrim bw-scrim">
      <div className="r1-dlg" role="dialog" aria-modal="true" aria-label={title} ref={box} onKeyDown={key}>
        <div className="r1-dlg-h">
          <h2>{title}</h2>
          <button type="button" className="r1-x" aria-label={t('accounts.dialog.close')} data-ctl={closeCtl} onClick={onClose}>
            <i className="ic" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: CLOSE_PATH }} />
            </i>
          </button>
        </div>
        <div className="r1-dlg-b">{children}</div>
        <div className="r1-dlg-f">{foot}</div>
      </div>
    </div>
  );
}

function Busy({ label, danger = false, ctl }: { label: string; danger?: boolean; ctl: string }) {
  return (
    <button type="button" className={`btn busy ${danger ? 'danger' : 'primary'}`} aria-busy="true" aria-disabled="true" data-ctl={ctl}>
      <span className="r1-spin" />
      {label}
    </button>
  );
}

function RoleRadios({ ctl, current, pick, onPick, disabled = false }: { ctl: string; current: Role | null; pick: Role | null; onPick: (r: Role) => void; disabled?: boolean }) {
  const t = useT();
  const move = (e: KeyboardEvent, r: Role) => {
    const i = ROLE_ORDER.indexOf(r);
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = ROLE_ORDER[(i + step + ROLE_ORDER.length) % ROLE_ORDER.length]!;
    onPick(next);
    (e.currentTarget.parentElement?.children[ROLE_ORDER.indexOf(next)] as HTMLElement | undefined)?.focus();
  };
  return (
    <div className="r1-field" data-ctl={ctl}>
      <label id={`${ctl}-l`}>{t('accounts.users.role')}</label>
      <div className="rads" role="radiogroup" aria-labelledby={`${ctl}-l`}>
        {ROLE_ORDER.map((r) => (
          <span
            key={r} className={`rad${r === pick ? ' on' : ''}`} role="radio" aria-checked={r === pick} aria-disabled={disabled || undefined}
            tabIndex={r === (pick ?? ROLE_ORDER[0]) ? 0 : -1} onClick={() => !disabled && onPick(r)} onKeyDown={(e) => !disabled && move(e, r)}
          >
            <i />
            {t(`shell.role.${r}`)}
            {r === current ? <> <small>{t('accounts.users.now')}</small></> : null}
          </span>
        ))}
      </div>
    </div>
  );
}

function InviteDialog({ d, setD, onSent }: { d: Extract<DialogState, { kind: 'invite' }>; setD: (d: DialogState | null) => void; onSent: () => void }) {
  const t = useT();
  const [name, setName] = useState(d.name ?? '');
  const [email, setEmail] = useState(d.email ?? '');
  const [role, setRole] = useState<Role | null>(d.role ?? null);
  const [branch, setBranch] = useState(d.branch ?? 'columbus');
  const [errs, setErrs] = useState<{ name?: string; email?: string; form?: string }>({});
  const [used, setUsed] = useState(false);
  const close = () => setD(null);
  const valid = name.trim().length > 0 && EMAIL.test(email.trim()) && role !== null;

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    if (d.step !== 'editing') return;
    const next: typeof errs = {};
    if (!name.trim()) next.name = t('accounts.field.nameRequired');
    if (!EMAIL.test(email.trim())) next.email = t('accounts.field.notEmail');
    if (role === null) next.form = t('accounts.invite.pickRole');
    setErrs(next);
    if (Object.keys(next).length) return;
    setD({ ...d, step: 'sending', name, email, role: role!, branch });
    const r = await callRow(rows.inviteUser, { name: name.trim(), email: email.trim(), role, branch });
    if (r.ok) {
      setD({ kind: 'invite', step: 'sent', name: name.trim(), email: email.trim(), role: role!, branch, sent: r.data });
      onSent();
      return;
    }
    setD({ ...d, step: 'editing', name, email, role: role!, branch });
    setErrs(r.code === 'already_a_user' ? { email: t('accounts.invite.taken') } : r.code === 'validation_failed' ? { form: t('accounts.invite.invalid') } : { form: t('accounts.users.actionFailed') });
  };

  if (d.step === 'sent' && d.sent) {
    const sent = d.sent;
    return (
      <Dialog title={t('accounts.invite.title')} closeCtl="CTL-OFC-44-07" onClose={close} initial="a[href], button.primary"
        foot={<button type="button" className="btn primary" data-ctl="CTL-OFC-44-07" onClick={close}>{t('accounts.dialog.closeButton')}</button>}>
        <p>
          <b>{t('accounts.invite.sentTo', { email: sent.user.email })}</b>{' '}
          {t('accounts.invite.joins', { name: sent.user.name, role: t(`shell.role.${sent.user.role}`), branch: branchById(sent.user.branch).name })}
        </p>
        {sent.employeeNumber ? <p>{t('accounts.invite.employeeNumber', { n: sent.employeeNumber })}</p> : null}
        <p>
          {used ? (
            <span>{t('accounts.linkUsed')}</span>
          ) : (
            <a className="r1-link" href={sent.emailLink} target="_blank" rel="noopener noreferrer" data-ctl="CTL-OFC-44-06" aria-describedby="invite-once" onClick={() => setUsed(true)}>
              {t('accounts.invite.open')}
            </a>
          )}
          <span className="bw-sr" id="invite-once">{t('accounts.invite.onceNote', { email: sent.user.email })}</span>
        </p>
      </Dialog>
    );
  }
  const sending = d.step === 'sending';
  return (
    <Dialog
      title={t('accounts.invite.title')} closeCtl="CTL-OFC-44-07" onClose={close}
      foot={
        <>
          <button type="button" className={`btn${sending ? ' dis' : ''}`} aria-disabled={sending || undefined} data-ctl="CTL-OFC-44-07" onClick={() => !sending && close()}>{t('accounts.dialog.cancel')}</button>
          {sending ? <Busy label={t('accounts.invite.sending')} ctl="CTL-OFC-44-05" /> : (
            <button type="submit" form="invite-form" className={`btn primary${valid ? '' : ' dis'}`} aria-disabled={!valid || undefined} data-ctl="CTL-OFC-44-05">{t('accounts.invite.send')}</button>
          )}
        </>
      }
    >
      <form id="invite-form" onSubmit={(e) => void send(e)} noValidate>
        <TextField id="inv-name" ctl="CTL-OFC-44-01" label={t('accounts.field.name')} value={name} onChange={setName} error={errs.name} disabled={sending} autoComplete="name" />
        <div className="bw-mt12">
          <TextField id="inv-email" ctl="CTL-OFC-44-02" label={t('accounts.field.email')} value={email} onChange={setEmail} error={errs.email} disabled={sending} type="email" autoComplete="email" />
        </div>
        <div className="bw-mt12"><RoleRadios ctl="CTL-OFC-44-03" current={null} pick={role} onPick={setRole} disabled={sending} /></div>
        <div className="bw-mt12">
          <div className="r1-field" data-ctl="CTL-OFC-44-04">
            <label htmlFor="inv-branch">{t('accounts.users.branch')}</label>
            <div className="r1-input bw-select">
              <span>{branchById(branch).name}</span>
              <select id="inv-branch" className="bw-fsel-native" value={branch} disabled={sending} onChange={(e) => setBranch(e.target.value)}>
                {BRANCHES.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
          </div>
        </div>
        {errs.form ? <div className="r1-fmsg" role="alert"><Icon name="alert" />{errs.form}</div> : null}
      </form>
    </Dialog>
  );
}

function TextField({ id, ctl, label, value, onChange, error, disabled, type = 'text', autoComplete }: { id: string; ctl: string; label: string; value: string; onChange: (v: string) => void; error?: string | undefined; disabled?: boolean; type?: string; autoComplete?: string }) {
  const [focus, setFocus] = useState(false);
  return (
    <div className="r1-field" data-ctl={ctl}>
      <label htmlFor={id}>{label}</label>
      <div className={`r1-input${error ? ' bad' : focus ? ' focus' : ''}`}>
        <input
          id={id} type={type} className="bw-field-input" value={value} disabled={disabled} autoComplete={autoComplete} spellCheck={false}
          aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-msg` : undefined}
          onChange={(e) => onChange(e.target.value)} onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
        />
      </div>
      {error ? <div className="r1-fmsg" role="alert" id={`${id}-msg`}><Icon name="alert" />{error}</div> : null}
    </div>
  );
}

function RoleDialog({ d, setD, onDone }: { d: Extract<DialogState, { kind: 'role' }>; setD: (d: DialogState | null) => void; onDone: (text: string) => Promise<unknown> }) {
  const t = useT();
  const [pick, setPick] = useState<Role>(d.pick ?? d.user.role);
  const [err, setErr] = useState<string | null>(null);
  const saving = d.step === 'saving';
  const changedPick = pick !== d.user.role;
  const close = () => !saving && setD(null);
  const save = async () => {
    if (saving || !changedPick) return;
    setD({ ...d, step: 'saving', pick });
    const r = await callRow(rows.setUserRole, { userId: d.user.id, role: pick });
    if (r.ok) return onDone(t('accounts.users.roleDone', { name: d.user.name, role: t(`shell.role.${pick}`) }));
    setD({ ...d, step: 'choosing', pick });
    setErr(r.code === 'rule_refused' ? t('accounts.users.refused') : t('accounts.users.actionFailed'));
  };
  return (
    <Dialog
      title={t('accounts.role.title', { name: d.user.name })} closeCtl="CTL-OFC-45-03" onClose={close} initial='[role="radio"][tabindex="0"]'
      foot={
        <>
          <button type="button" className={`btn${saving ? ' dis' : ''}`} aria-disabled={saving || undefined} data-ctl="CTL-OFC-45-03" onClick={close}>{t('accounts.dialog.cancel')}</button>
          {saving ? <Busy label={t('accounts.role.saving')} ctl="CTL-OFC-45-02" /> : (
            <button type="button" className={`btn primary${changedPick ? '' : ' dis'}`} aria-disabled={!changedPick || undefined} data-ctl="CTL-OFC-45-02" onClick={() => void save()}>{t('accounts.role.save')}</button>
          )}
        </>
      }
    >
      <RoleRadios ctl="CTL-OFC-45-01" current={d.user.role} pick={pick} onPick={setPick} disabled={saving} />
      {err ? <div className="r1-fmsg" role="alert"><Icon name="alert" />{err}</div> : null}
    </Dialog>
  );
}

function OffDialog({ d, setD, onDone }: { d: Extract<DialogState, { kind: 'off' }>; setD: (d: DialogState | null) => void; onDone: (text: string) => Promise<unknown> }) {
  const t = useT();
  const [err, setErr] = useState<string | null>(null);
  const turning = d.step === 'turning';
  const close = () => !turning && setD(null);
  const confirm = async () => {
    if (turning) return;
    setD({ ...d, step: 'turning' });
    const r = await callRow(rows.turnUserOff, { userId: d.user.id });
    if (r.ok) return onDone(t('accounts.users.offDone', { name: d.user.name }));
    setD({ ...d, step: 'asking' });
    setErr(r.code === 'rule_refused' ? t('accounts.users.refused') : t('accounts.users.actionFailed'));
  };
  return (
    <Dialog
      title={t('accounts.off.title', { name: d.user.name })} closeCtl="CTL-OFC-46-03" onClose={close} initial='[data-ctl="CTL-OFC-46-03"].btn'
      foot={
        <>
          <button type="button" className={`btn${turning ? ' dis' : ''}`} aria-disabled={turning || undefined} data-ctl="CTL-OFC-46-03" onClick={close}>{t('accounts.dialog.cancel')}</button>
          {turning ? <Busy label={t('accounts.off.turning')} danger ctl="CTL-OFC-46-02" /> : (
            <button type="button" className="btn danger" data-ctl="CTL-OFC-46-02" onClick={() => void confirm()}>{t('accounts.users.turnOff')}</button>
          )}
        </>
      }
    >
      <p data-ctl="CTL-OFC-46-01">{t('accounts.off.message', { name: d.user.name })}</p>
      {err ? <div className="r1-fmsg" role="alert"><Icon name="alert" />{err}</div> : null}
    </Dialog>
  );
}
