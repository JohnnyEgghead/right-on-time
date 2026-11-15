// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// CMP-08 admin side menu (CTL-CMP-08-01; DK-42, markup DK-78), CMP-14 public page header (CTL-CMP-14-01; DK-25, markup
// DK-80) and CMP-15 booking site header (CTL-CMP-15-01 to CTL-CMP-15-05; DK-66).
import { usePathname } from 'next/navigation';
import { useLayoutEffect, useRef, useState } from 'react';
import type { Branch } from './branches.ts';
import { CallButton } from './CallButton.tsx';
import { Icon, Mark } from './Icon.tsx';
import type { IconName } from './icon-paths.ts';
import { useT } from './intl.tsx';
import { LanguageSwitch } from './LanguageSwitch.tsx';
import { ADMIN_ENTRIES, isCurrent, visibleEntries } from './office-nav.ts';

const ADMIN_ICONS: Record<string, IconName> = { windows: 'clock', users: 'user', import: 'download', health: 'gauge', clock: 'calendar' };

/** CMP-08: Users and roles, System health and Demo clock show to managers only, by API-07's permissions. */
export function AdminSide({ permissions, currentPath }: { permissions: readonly string[]; currentPath?: string }) {
  const t = useT();
  const routePath = usePathname();
  const pathname = currentPath ?? routePath ?? '';
  return (
    <nav className="side" data-ctl="CTL-CMP-08-01" data-cmp="CMP-08" aria-label={t('shell.office.nav.admin')}>
      <h4>{t('shell.office.nav.admin')}</h4>
      {visibleEntries(ADMIN_ENTRIES, permissions).map((e) => {
        const on = isCurrent(e, pathname);
        return (
          <a key={e.id} href={e.href} className={on ? 'on' : undefined} aria-current={on ? 'page' : undefined}>
            <Icon name={ADMIN_ICONS[e.id] ?? 'list'} />
            <span>{t(e.label)}</span>
          </a>
        );
      })}
    </nav>
  );
}

/** CMP-14: the brand (not a link) and the page branch's office number as text, not a call link (UD-30). */
export function PublicHeader({ branch, showPhone = true, brandHref }: { branch: Branch; showPhone?: boolean; brandHref?: string }) {
  const t = useT();
  const brand = (
    <>
      <Mark />
      <span className="word">
        {t('brand.name')}
        <small>{t('brand.trade')}</small>
      </span>
    </>
  );
  return (
    <header className="r1-pubhead" data-ctl="CTL-CMP-14-01" data-cmp="CMP-14">
      {brandHref ? (
        <a className="brand" href={brandHref}>
          {brand}
        </a>
      ) : (
        <span className="brand">{brand}</span>
      )}
      <span className="prod">{t('brand.product')}</span>
      <span className="grow" />
      <LanguageSwitch />
      {showPhone ? (
        <span className="tel">
          {branch.officePhone}
          <small>{t('shell.public.office', { branch: branch.name })}</small>
        </span>
      ) : null}
    </header>
  );
}

const SITE_LINKS = [
  { href: '/book/heating', label: 'shell.booking.heating' },
  { href: '/book/cooling', label: 'shell.booking.cooling' },
  { href: '/book/plumbing', label: 'shell.booking.plumbing' },
  { href: '/book/comfort-club', label: 'shell.booking.club' },
  { href: '/book/about-us', label: 'shell.booking.about' },
] as const;

/** CMP-15: brand, site menu, language switch, the office phone (a CMP-16 Call control) and Book a visit. */
export function BookingHeader({ branch, currentPath }: { branch: Branch; currentPath?: string }) {
  const t = useT();
  const routePath = usePathname();
  const pathname = currentPath ?? routePath ?? '';
  const ref = useRef<HTMLElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [open, setOpen] = useState(false);
  // F-975: a re-check draws the full menu again (narrow false), and the header is measured only once that draw is committed (the layout effect
  // below, keyed on `probe`). A measure in a requestAnimationFrame could run before React committed the full menu, read the narrow header as fitting
  // and leave the full menu overflowing: 1273 px of header in a 520 px page.
  const [probe, setProbe] = useState(0);
  useLayoutEffect(() => {
    const h = ref.current;
    if (!h || narrow) return;
    if (h.scrollWidth > h.clientWidth + 1) setNarrow(true);
  }, [probe, narrow]);
  // CTL-CMP-15-05: the menu button shows only when the header overflows.
  useLayoutEffect(() => {
    const h = ref.current;
    if (!h) return;
    const check = () => {
      setNarrow(false);
      setProbe((n) => n + 1);
    };
    check();
    // Only a change of width re-checks: the narrow state changes the header's height (it wraps), which must not start the check again.
    let lastWidth = h.clientWidth;
    const ro = new ResizeObserver(() => {
      if (h.clientWidth === lastWidth) return;
      lastWidth = h.clientWidth;
      check();
    });
    ro.observe(h);
    // The header's own size does not change when the web font lands or the page finishes loading, but the width of what it holds does.
    let live = true;
    void document.fonts?.ready.then(() => live && check());
    window.addEventListener('load', check);
    return () => {
      live = false;
      window.removeEventListener('load', check);
      ro.disconnect();
    };
  }, []);
  const links = SITE_LINKS.map((l) => {
    const on = pathname === l.href;
    return (
      <a key={l.href} href={l.href} className={on ? 'on' : undefined} aria-current={on ? 'page' : undefined}>
        {t(l.label)}
      </a>
    );
  });
  const book = (
    <a className="btn primary" href="/book" data-ctl="CTL-CMP-15-03">
      {t('shell.booking.book')}
    </a>
  );
  return (
    <header className={narrow ? 'site bw-narrow' : 'site'} ref={ref} data-cmp="CMP-15">
      <a className="brand" href="/book" data-ctl="CTL-CMP-15-01">
        <Mark />
        <span className="word">
          {t('brand.name')}
          <small>{t('brand.trade')}</small>
        </span>
      </a>
      {narrow ? null : (
        <nav data-ctl="CTL-CMP-15-02" aria-label={t('shell.booking.siteMenu')}>
          {links}
        </nav>
      )}
      <span className="grow" />
      <LanguageSwitch />
      <CallButton name={t('brand.name')} number={branch.officePhone} className="tel bw-btn-reset">
        <Icon name="phone" />
        {branch.officePhone}
      </CallButton>
      {narrow ? (
        <button type="button" className="menu bw-btn-reset" aria-label={t('shell.booking.menu')} aria-expanded={open} data-ctl="CTL-CMP-15-05" onClick={() => setOpen((o) => !o)}>
          <Icon name="list" />
        </button>
      ) : (
        book
      )}
      {narrow && open ? (
        <div className="r1-menu bw-site-menu" role="menu" aria-label={t('shell.booking.siteMenu')} data-ctl="CTL-CMP-15-05">
          {links}
          {book}
        </div>
      ) : null}
    </header>
  );
}
