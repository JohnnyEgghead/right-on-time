// SPDX-License-Identifier: AGPL-3.0-or-later
// The server address (FR-IOS-3; SPECIFICATIONS 6.12; SCR-TEC-12 CTL-TEC-12-01): the hosted demo by default, or another origin the
// person types. Pure: React Native's URL is partial, so the address is read here by its own rules, the same on the phone and in tests.

/** The hosted demo (SPECIFICATIONS 6.12: "The default server is https://bw.j7l.io"). */
export const DEFAULT_SERVER = 'https://bw.j7l.io';

const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * The origin a typed address names: http or https, a host name or an IPv4 address, an optional port, and nothing after it but 1
 * slash. Anything else is not a web address (the field's message). The scheme is required: a local copy is often plain http.
 */
export function parseOrigin(text: string): string | null {
  const m = /^(https?):\/\/([^/:?#\s]+)(?::(\d{1,5}))?\/?$/i.exec(text.trim());
  if (!m) return null;
  const scheme = (m[1] as string).toLowerCase();
  const host = (m[2] as string).toLowerCase();
  const ip = IPV4.exec(host);
  if (ip) {
    if (ip.slice(1).some((o) => Number(o) > 255)) return null;
  } else if (!HOST.test(host) || /^\d+$/.test(host.split('.').at(-1) as string) || (host !== 'localhost' && !host.includes('.'))) {
    // A host name has a dot (or is localhost), and its last label is not all digits: "192.168.1" is no address.
    return null;
  }
  const port = m[3] === undefined ? null : Number(m[3]);
  if (port !== null && (port < 1 || port > 65535)) return null;
  const isDefault = port === null || (scheme === 'https' && port === 443) || (scheme === 'http' && port === 80);
  return `${scheme}://${host}${isDefault ? '' : `:${port}`}`;
}

/** The address as the sign-in screen's Server row shows it (CTL-TEC-01-06): no scheme, so the row reads like the frame's. */
export function shownAddress(origin: string): string {
  return origin.replace(/^https?:\/\//, '');
}
