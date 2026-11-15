// SPDX-License-Identifier: AGPL-3.0-or-later
// DK-70 icons and DK-69 drop-and-flame mark, as the kit frames render them after their scripts run.
import { ICON_PATHS, type IconName } from './icon-paths.ts';

export function Icon({ name, sw, className }: { name: IconName; sw?: number; className?: string }) {
  return (
    <i data-icon={name} className={className ? `ic ${className}` : 'ic'} aria-hidden="true">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={sw ?? 1.9}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        // The paths are this module's own constants (DK-70), never data.
        dangerouslySetInnerHTML={{ __html: ICON_PATHS[name] }}
      />
    </i>
  );
}

/** DK-69, from mockups/src/assets/brand.js ("// Brightwater mark: a cool water drop holding a warm flame."). */
export function Mark() {
  return (
    <svg className="mark" viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="bwDrop" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1a8aa5" />
          <stop offset="1" stopColor="#0c4b5d" />
        </linearGradient>
        <linearGradient id="bwFlame" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffb35c" />
          <stop offset="1" stopColor="#e2580c" />
        </linearGradient>
      </defs>
      <path d="M16 1.8C16 1.8 5.4 13.2 5.4 19.9C5.4 25.8 10.1 30.2 16 30.2C21.9 30.2 26.6 25.8 26.6 19.9C26.6 13.2 16 1.8 16 1.8Z" fill="url(#bwDrop)" />
      <path d="M9.4 15.2C10.4 12.9 12 10.6 13.4 8.9" stroke="#ffffff" strokeOpacity=".35" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      <path d="M16.9 11.6C17.6 15.2 21.4 17.1 21.4 21.6C21.4 24.8 19.1 27.1 16 27.1C12.9 27.1 10.6 24.9 10.6 21.9C10.6 19.3 12.2 17.6 13.5 16.4C13.5 18.3 14.3 19.5 15.5 20C15.1 17.1 15.6 14 16.9 11.6Z" fill="url(#bwFlame)" />
      <path d="M16.3 19.4C16.7 21.1 18.4 22 18.4 24C18.4 25.4 17.4 26.3 16.1 26.3C14.8 26.3 13.8 25.4 13.8 24.1C13.8 22.9 14.6 22.2 15.2 21.6C15.2 22.4 15.6 23 16.1 23.2C15.9 21.9 16 20.5 16.3 19.4Z" fill="#fff3e0" />
    </svg>
  );
}
