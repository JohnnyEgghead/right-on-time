// SPDX-License-Identifier: AGPL-3.0-or-later
// Static checks of infra/nginx against SPECIFICATIONS section 11.4 (SD-42) and the S1 fold-in.
// The live proof is the access-log line on the hosted server (.build/evidence/P1-DEPLOY/).
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = path.resolve(import.meta.dirname, '../nginx');
const read = (f: string) => readFileSync(path.join(dir, f), 'utf8');
const strip = (s: string) => s.split('\n').map((l) => l.replace(/#.*$/, '')).join('\n');
const http = strip(read('http.conf'));

// The 2 maps in http.conf, run in JavaScript: $request_uri -> path without query -> token-mapped.
function mapLogUri(requestUri: string): string {
  const q = /map \$request_uri \$bw_path \{\s*"~([^"]+)" \$path;/.exec(http);
  const t = /map \$bw_path \$bw_log_uri \{\s*"~([^"]+)" ([^;]+);\s*default \$bw_path;/.exec(http);
  if (!q || !t) throw new Error('http.conf maps not found');
  const p = new RegExp(q[1]!).exec(requestUri)!.groups!.path!;
  const m = new RegExp(t[1]!).exec(p);
  return m ? t[2]!.replace(/\$(\w+)/g, (_, g: string) => m.groups![g] ?? '') : p;
}

describe('nginx access log (11.4)', () => {
  // why: SD-42, NFR-05
  it('replaces the token segment of every 11.4 token route with :token', () => {
    expect(mapLogUri('/m/Zq3xY9-abc')).toBe('/m/:token');
    expect(mapLogUri('/r/Zq3xY9')).toBe('/r/:token');
    expect(mapLogUri('/inbox/Zq3xY9')).toBe('/inbox/:token');
    expect(mapLogUri('/email/Zq3xY9')).toBe('/email/:token');
    expect(mapLogUri('/set-password/Zq3xY9')).toBe('/set-password/:token');
    expect(mapLogUri('/book/done/Zq3xY9')).toBe('/book/done/:token');
    expect(mapLogUri('/m/Zq3xY9/map.json')).toBe('/m/:token/map.json');
  });

  // why: SD-42, F-611
  it('replaces the token of every link-token route in the contract table with :token', async () => {
    // The population is the contract table itself (isLinkTokenRoute), so a token route added later is covered with no edit here.
    const { allContracts, fillPath, isLinkTokenRoute, servedPath } = await import('../../packages/api/src/index.ts');
    const rows = allContracts.filter(isLinkTokenRoute);
    expect(rows.length).toBeGreaterThanOrEqual(3); // API-166, API-167, API-168 at least: an empty population proves nothing
    const fake = 'T'.repeat(43); // shaped like a 43-character link token (F-2930: a fixture value is 1 repeated character)
    for (const r of rows) {
      const tpl = servedPath(r);
      const params = Object.fromEntries([...tpl.matchAll(/\{(\w+)\}/g)].map((m) => [m[1]!, /[tT]oken$/.test(m[1]!) ? fake : 'x1']));
      const logged = mapLogUri(fillPath(tpl, params));
      expect(logged, `${r.id} ${tpl}`).not.toContain(fake);
      expect(logged, `${r.id} ${tpl}`).toBe(tpl.replace(/\{\w*[tT]oken\}/g, ':token').replace(/\{\w+\}/g, 'x1'));
    }
  });

  // why: SD-42, NFR-05
  it('never logs a query string, and leaves other paths as they are', () => {
    expect(mapLogUri('/m/Zq3xY9?phone=6145550100')).toBe('/m/:token');
    expect(mapLogUri('/office/board?day=2026-09-15')).toBe('/office/board');
    expect(mapLogUri('/healthz')).toBe('/healthz');
    expect(mapLogUri('/m')).toBe('/m');
    expect(mapLogUri('/mm/Zq3xY9')).toBe('/mm/Zq3xY9');
    expect(mapLogUri('/book/Zq3xY9')).toBe('/book/Zq3xY9');
  });

  // why: SD-42, NFR-05
  it('logs only the mapped URI: no request line, raw URI, query, Referer, address or user agent', () => {
    const fmt = /log_format bw escape=json '([^']+)';/.exec(http)?.[1];
    expect(fmt).toBeDefined();
    expect(fmt).toContain('$request_method');
    expect(fmt).toContain('$bw_log_uri');
    for (const v of ['$request ', '$request"', '$request_uri', '$uri', '$args', '$query_string', '$http_referer', '$remote_addr', '$http_user_agent', '$http_x_forwarded_for']) {
      expect(fmt, v).not.toContain(v);
    }
  });

  // why: SD-42, NFR-05
  it('writes every server block of every site file with the bw format (so nginx.conf "main" never applies)', () => {
    for (const f of ['hosted.conf', 'local.conf', 'bootstrap.conf']) {
      const conf = strip(read(f));
      expect(conf, f).toContain('include /etc/nginx/bw/http.conf;');
      const blocks = conf.split(/\bserver \{/).slice(1);
      expect(blocks.length, f).toBeGreaterThan(0);
      for (const b of blocks) expect(b, f).toMatch(/access_log \/var\/log\/nginx\/access\.log bw;/);
    }
    expect(readdirSync(dir).filter((f) => f.endsWith('.conf')).sort()).toEqual(
      ['bootstrap.conf', 'hosted.conf', 'http.conf', 'local.conf', 'proxied-headers.conf', 'routes-locked.conf', 'routes-open.conf', 'security-headers.conf'],
    );
    for (const f of ['security-headers.conf', 'proxied-headers.conf']) expect(strip(read(f)), f).not.toMatch(/\bserver\b|\blocation\b/); // a header snippet, never a site
  });
});

describe('nginx routes', () => {
  // why: NFR-12, FR-MAP-3
  it('has no route to the routing service (SD-49: on the Compose network only), and serves no routing file from the map volume', () => {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.conf'))) {
      const conf = strip(read(f));
      expect(conf, f).not.toMatch(/\brouting\b|:5000\b|osrm/i);
      // every proxy_pass goes to the web upstream; the map volume is read only through the 3 branch PMTiles names
      for (const m of conf.matchAll(/proxy_pass\s+([^;]+);/g)) expect(m[1], f).toMatch(/^http:\/\/bw_web(\/|$)/);
      for (const m of conf.matchAll(/alias\s+(\/data\/maps\/[^;]*);/g)) expect(m[1], f).toBe('/data/maps/$bw_map.pmtiles');
    }
    const upstreams = [...strip(read('http.conf')).matchAll(/upstream\s+(\w+)\s*\{[^}]*?server\s+([^\s;]+)/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(upstreams).toEqual(['bw_web web:3000']);
  });

  // why: SD-40
  it('locked routes send only /healthz to the web container; every other path is the placeholder', () => {
    const locked = strip(read('routes-locked.conf'));
    expect(locked.match(/proxy_pass/g)).toHaveLength(1);
    expect(locked).toMatch(/location = \/healthz \{[^}]*proxy_pass http:\/\/bw_web;/);
    expect(locked).toMatch(/location \/ \{[^}]*root \/usr\/share\/nginx\/placeholder;[^}]*try_files \/index\.html =404;/);
    expect(locked).not.toMatch(/error_page/);
  });

  // why: F-101, NFR-12
  it('answers every nginx-served location with the 11.5 headers, the CSP text equal to the kernel one', async () => {
    const { CONTENT_SECURITY_POLICY } = await import('../../packages/api-server/src/kernel/headers.ts');
    const snippet = strip(read('security-headers.conf'));
    expect(snippet).toContain(`add_header Content-Security-Policy "${CONTENT_SECURITY_POLICY}" always;`);
    expect(snippet).toContain('add_header X-Content-Type-Options "nosniff" always;');
    expect(snippet).toContain('add_header Referrer-Policy "no-referrer" always;');
    expect(snippet).toContain('add_header Strict-Transport-Security $bw_hsts always;');
    const locked = strip(read('routes-locked.conf'));
    const fileLocations = [...locked.matchAll(/location ([^{]+)\{([^}]*)\}/g)].filter((m) => /\broot\b/.test(m[2]!));
    expect(fileLocations.map((m) => m[1]!.trim())).toEqual(['= /placeholder.css', '/']);
    for (const m of fileLocations) expect(m[2], m[1]).toContain('include /etc/nginx/bw/security-headers.conf;');
  });

  // why: F-1795 (the port-80 bootstrap answered with no 11.5 header; hosted.conf and the locked routes send them)
  it('sends the same 11.5 headers from bootstrap.conf as hosted.conf and its routes do', async () => {
    const { SECURITY_HEADERS } = await import('../../packages/api-server/src/kernel/headers.ts');
    const names = [...strip(read('security-headers.conf')).matchAll(/add_header ([A-Za-z-]+) /g)].map((m) => m[1]!.toLowerCase()).sort();
    expect(names).toEqual([...Object.keys(SECURITY_HEADERS), 'strict-transport-security'].sort());
    const boot = strip(read('bootstrap.conf'));
    const server = /server \{([\s\S]*)\}\s*$/.exec(boot)![1]!;
    // At server level, so every answer without a header of its own gets them
    expect(server.replace(/location [^{]+\{[^}]*\}/g, '')).toContain('include /etc/nginx/bw/security-headers.conf;');
    // A location that adds a header of its own drops the inherited ones, so it repeats the include
    for (const m of server.matchAll(/location ([^{]+)\{([^}]*)\}/g)) {
      if (/add_header/.test(m[2]!)) expect(m[2], m[1]).toContain('include /etc/nginx/bw/security-headers.conf;');
    }
    // and the hosted site adds the same HSTS value at server level, so the two answer alike
    expect(strip(read('hosted.conf'))).toContain('add_header Strict-Transport-Security $bw_hsts always;');
  });

  // why: F-214 (nginx's own 502 answers in the proxied locations carried HSTS only; proxy-headers.maps.test.ts is the live check)
  it("adds the 11.5 headers to nginx's own answers in the proxied locations, and none a web answer already sent", async () => {
    const { SECURITY_HEADERS } = await import('../../packages/api-server/src/kernel/headers.ts');
    const snippet = strip(read('proxied-headers.conf'));
    // Each header comes from a map in http.conf keyed on the web answer's own header: the 11.5 value when web sent none, else empty.
    const lines = [...snippet.matchAll(/add_header ([A-Za-z-]+) \$(\w+) always;/g)];
    expect(lines.map((m) => m[1]!.toLowerCase()).sort()).toEqual(Object.keys(SECURITY_HEADERS).sort());
    expect(snippet).not.toMatch(/Strict-Transport-Security/); // hosted.conf adds HSTS at server level; a 2nd line would double it
    for (const [, header, variable] of lines) {
      const upstream = `$upstream_http_${header!.toLowerCase().replace(/-/g, '_')}`;
      const map = new RegExp(`map \\${upstream} \\$${variable} \\{\\s*""\\s+"([^"]+)";\\s*default "";\\s*\\}`).exec(http);
      expect(map?.[1], header).toBe(SECURITY_HEADERS[header!.toLowerCase()]);
    }
    // Included at server level (before any location) in both routes files, so every location without its own add_header inherits it.
    for (const f of ['routes-open.conf', 'routes-locked.conf']) {
      const conf = strip(read(f));
      const at = conf.indexOf('include /etc/nginx/bw/proxied-headers.conf;');
      expect(at, f).toBeGreaterThan(-1);
      expect(at, f).toBeLessThan(conf.indexOf('location '));
      // Every proxied location adds no header of its own (an add_header there would drop the inherited ones).
      for (const m of conf.matchAll(/location ([^{]+)\{([^}]*)\}/g)) if (/proxy_pass/.test(m[2]!)) expect(m[2], `${f} ${m[1]}`).not.toMatch(/add_header/);
    }
  });

  // why: F-101
  it('sends HSTS only on HTTPS: the hosted 443 server for proxied answers, the $bw_hsts map empty on plain HTTP', () => {
    expect(http).toMatch(/map \$scheme \$bw_hsts \{\s*https\s+"max-age=31536000";\s*default "";\s*\}/);
    const hosted = strip(read('hosted.conf'));
    const tls = /listen 443 ssl[\s\S]*$/.exec(hosted)?.[0] ?? '';
    expect(tls).toContain('add_header Strict-Transport-Security $bw_hsts always;');
    expect(strip(read('local.conf'))).not.toMatch(/Strict-Transport-Security/);
  });

  // why: F-101, NFR-12
  it('keeps the placeholder free of inline style and script, so the CSP allows it', () => {
    const page = readFileSync(path.resolve(import.meta.dirname, '../placeholder/index.html'), 'utf8');
    expect(page).not.toMatch(/<style|<script|\sstyle=|\son\w+=/i);
    expect(page).toContain('href="/placeholder.css"');
  });

  // why: SD-4
  it('overwrites X-Forwarded-For with the peer address on the open routes (the rate limits count by it)', () => {
    expect(strip(read('routes-open.conf'))).toContain('proxy_set_header X-Forwarded-For $remote_addr;');
  });

  // why: SD-4 (J-27, F-2008: the locked /healthz reaches the kernel too, so it overwrites a client's X-Forwarded-For with the peer as the open routes do)
  it('overwrites X-Forwarded-For with the peer address in the locked /healthz location', () => {
    expect(strip(read('routes-locked.conf'))).toMatch(/location = \/healthz \{[^}]*proxy_set_header X-Forwarded-For \$remote_addr;/);
  });

  // why: F-61
  it('open routes carry the S1 event-stream location: no buffering, no cache, no gzip, 1 h read timeout', () => {
    const open = strip(read('routes-open.conf'));
    const ev = /location = \/api\/v1\/events \{([^}]*)\}/.exec(open)?.[1] ?? '';
    for (const d of ['proxy_pass http://bw_web;', 'proxy_buffering off;', 'proxy_cache off;', 'gzip off;', 'proxy_read_timeout 1h;']) {
      expect(ev, d).toContain(d);
    }
    expect(open).toContain('proxy_http_version 1.1;');
    expect(open).toContain('proxy_set_header Connection "";');
  });

  // why: F-97 (11.4: no token, query or client address in any proxy log; the error log wrote the raw request line)
  it('holds the error log of every request at crit in http.conf, and no site or routes file lowers it', () => {
    expect(http).toMatch(/^error_log \/var\/log\/nginx\/error\.log crit;$/m);
    // http.conf is included first by every site file that serves requests
    for (const f of ['hosted.conf', 'local.conf', 'bootstrap.conf']) expect(strip(read(f)), f).toMatch(/^include \/etc\/nginx\/bw\/http\.conf;$/m);
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.conf') && x !== 'http.conf')) {
      expect(strip(read(f)), f).not.toMatch(/\berror_log\b/);
    }
  });

  // why: F-1592 (a failed lookup of web kept its old address for the 30 s default resolver_timeout: up to about 30 s of 502)
  it('bounds the resolver timeout beside the resolver line, so a moved web is found again within seconds', () => {
    expect(http).toMatch(/^resolver 127\.0\.0\.11 valid=2s ipv6=off;\n(?:\s*\n)*resolver_timeout 3s;$/m);
  });
});
