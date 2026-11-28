// SPDX-License-Identifier: AGPL-3.0-or-later
// @bw/config (SPECIFICATIONS section 11.1): every setting is an environment variable read once at start-up and validated
// by 1 Zod schema; an invalid value stops the process with a named error (ConfigError names the setting, never its value,
// so a secret is never printed). The own-copy defaults are the 11.1 table's; the hosted values come from the server's .env.
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const onOff = z.enum(['on', 'off']).transform((v) => v === 'on');
const int = (min: number) => z.string().regex(/^\d+$/, 'must be a whole number').transform(Number).pipe(z.number().int().min(min));
const optionalSecret = (min: number) => z.string().min(min, `must be at least ${min} characters`).optional();

function origin(v: string, ctx: z.RefinementCtx): string {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'must be an http or https origin, for example https://bw.j7l.io' });
    return z.NEVER;
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.origin !== v.replace(/\/$/, '')) {
    ctx.addIssue({ code: 'custom', message: 'must be an http or https origin with no path, query or credentials' });
    return z.NEVER;
  }
  return u.origin;
}

const absPath = z.string().regex(/^\/[^\0]*$/, 'must be an absolute path');
const host = z.string().regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'must be a lower-case host name');

/** The settings of section 11.1, as the environment spells them. Unknown variables are ignored (the environment holds more). */
export const settingsSchema = z
  .object({
    APP_ORIGIN: z.string().prefault('http://localhost:8080').transform(origin),
    TEXT_LINK_HOST: host.default('bw.j7l.io'),
    DEMO_MODE: onOff.prefault('off'),
    ACCESS_CODE_ON: onOff.prefault('off'),
    ACCESS_CODE: optionalSecret(6),
    ACCESS_COOKIE_KEY: optionalSecret(32),
    RESET_PROTECTION: onOff.prefault('off'),
    SAMPLE_PASSWORD_SEED: optionalSecret(16),
    REVIEWER_PASSWORD: optionalSecret(10),
    NIGHTLY_RESET: onOff.prefault('off'),
    IDLE_RESET_MINUTES: int(0).prefault('120'),
    RESET_COOLDOWN_SECONDS: int(0).prefault('300'),
    SOURCE_REPO_URL: z.url({ protocol: /^https$/ }).default('https://github.com/JohnnyEgghead/right-on-time'),
    PUBLIC_COMMIT: z.string().regex(/^(unknown|[0-9a-f]{7,40})$/, 'must be unknown or a commit sha').default('unknown'),
    IOS_INSTALL_KIND: z.enum(['none', 'unlisted', 'adhoc']).default('none'),
    IOS_INSTALL_LINK: z.string().default(''),
    BACKUP_TARGET: z.enum(['none', 'lightsail']).default('none'),
    BACKUP_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'must be a bucket name').optional(),
    BACKUP_REGION: z.enum(['us-east-1', 'us-east-2']).optional(),
    DATA_LOCATION_APP: z.string().min(1).default('This computer'),
    DATA_LOCATION_BACKUPS: z.string().min(1).default('This computer'),
    DATA_LOCATION_TEXTS: z.string().min(1).default('This computer'),
    DATA_LOCATION_MAPS: z.string().min(1).default('This computer'),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }).optional(),
    /** The file holding this process's database password (F-150: written by the migrate step, never in the environment). */
    DATABASE_PASSWORD_FILE: absPath.optional(),
    PBS_URL: z.url({ protocol: /^https?$/ }).default('http://pbs:8090'),
    PHOTOS_DIR: absPath.default('/data/photos'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  })
  .superRefine((s, ctx) => {
    // 11.1: the install kind and its link are checked together at start-up; anything else stops the server.
    const link = s.IOS_INSTALL_LINK;
    const adhoc = `itms-services://?action=download-manifest&url=${s.APP_ORIGIN}/ios/manifest.plist`;
    const bad =
      (s.IOS_INSTALL_KIND === 'none' && link !== '') ||
      (s.IOS_INSTALL_KIND === 'unlisted' && !/^https:\/\/apps\.apple\.com\/\S+$/.test(link)) ||
      (s.IOS_INSTALL_KIND === 'adhoc' && link !== adhoc);
    if (bad) {
      const want = { none: 'an empty link', unlisted: 'an https://apps.apple.com/ link', adhoc: `the link ${adhoc}` }[s.IOS_INSTALL_KIND];
      ctx.addIssue({ code: 'custom', path: ['IOS_INSTALL_LINK'], message: `IOS_INSTALL_KIND=${s.IOS_INSTALL_KIND} needs ${want}` });
    }
  });

export type Settings = z.output<typeof settingsSchema>;
export type SettingName = keyof z.input<typeof settingsSchema>;

/** The named start-up error: which setting is wrong and why. The value is never part of the message. */
export class ConfigError extends Error {
  readonly setting: string;
  constructor(setting: string, reason: string) {
    super(`invalid setting ${setting}: ${reason}`);
    this.name = 'ConfigError';
    this.setting = setting;
  }
}

/** Validate the environment once. Throws ConfigError naming the first invalid setting. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Readonly<Settings> {
  // An empty value counts as unset (Compose writes KEY= for a blank interpolation), except the install link, whose empty
  // value is the meaningful own-copy default.
  const input: Record<string, string> = {};
  for (const key of Object.keys(settingsSchema.shape)) {
    const v = env[key];
    if (v !== undefined && (v !== '' || key === 'IOS_INSTALL_LINK')) input[key] = v;
  }
  const r = settingsSchema.safeParse(input);
  if (!r.success) {
    const issue = r.error.issues[0]!;
    throw new ConfigError(String(issue.path[0] ?? 'environment'), issue.message);
  }
  return Object.freeze(r.data);
}

/** The database password of this process, read from DATABASE_PASSWORD_FILE (trailing newline dropped), or undefined. */
export function databasePassword(settings: Pick<Settings, 'DATABASE_PASSWORD_FILE'>): string | undefined {
  const file = settings.DATABASE_PASSWORD_FILE;
  if (file === undefined) return undefined;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw new ConfigError('DATABASE_PASSWORD_FILE', `cannot be read (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  const pw = text.replace(/\r?\n$/, '');
  if (pw.length < 16) throw new ConfigError('DATABASE_PASSWORD_FILE', 'holds no password of at least 16 characters');
  return pw;
}

/**
 * Start-up entry for the database password: databasePassword, or on a ConfigError the named message on stderr and exit
 * 78 (EX_CONFIG), as configOrExit does for the settings. Web, worker and pbs share this 1 implementation.
 */
export function databasePasswordOrExit(settings: Pick<Settings, 'DATABASE_PASSWORD_FILE'>): string | undefined {
  try {
    return databasePassword(settings);
  } catch (e) {
    if (e instanceof ConfigError) exitWithMessage(`${e.name}: ${e.message}`, 78);
    throw e;
  }
}

/**
 * The one sanctioned free-text exit of a process, for a failure before it has a logger (log-allowlist, F-234): the
 * message names a setting or a missing file, never data. Writes it to stderr and exits with `status`.
 */
export function exitWithMessage(message: string, status: number): never {
  // eslint-disable-next-line bw/log-allowlist -- the one sanctioned sink (F-328); G-CI6 scans every container log at run time for data.
  process.stderr.write(`${message}\n`);
  process.exit(status);
}

/**
 * Start-up entry for a process: validate, or stop the process. On an invalid setting it writes the named error to stderr
 * and exits with status 78 (EX_CONFIG), before the process serves anything.
 */
export function configOrExit(env: Record<string, string | undefined> = process.env): Readonly<Settings> {
  try {
    return loadConfig(env);
  } catch (e) {
    if (e instanceof ConfigError) exitWithMessage(`${e.name}: ${e.message}`, 78);
    throw e;
  }
}
