// SPDX-License-Identifier: AGPL-3.0-or-later
// @bw/api-server (SPECIFICATIONS SD-2, section 4.1): the HTTP handler kernel, the policy table and the handlers.
export * from './types.ts';
export { ACCESS_COOKIE, ACCESS_COOKIE_DAYS, accessCookieValid, generatedAccessKey, issueAccessCookie, requestIsHttps } from './kernel/access-code.ts';
export { authorize, codeFree, codePassed, type GateState, type Verdict } from './kernel/authorize.ts';
export { applySecurityHeaders, CONTENT_SECURITY_POLICY, SECURITY_HEADERS } from './kernel/headers.ts';
export { checkTable, DEFAULT_ZONE, mount, MountError, problem, type CallInfo, type KernelDb, type KernelDeps, type Router } from './kernel/mount.ts';
export { OFFICE_SIGN_IN, pageGate, pageRequestVerdict, TECH_SIGN_IN, type PageGate, type PageRequestDeps, type PageVerdict } from './kernel/pages.ts';
export { RateLimiter, rateRules, type RateRule } from './kernel/rate-limit.ts';
export { compilePath, specificity, tokenParam } from './kernel/route.ts';
export {
  hashToken, isTokenShape, lifetimes, MemorySessionStore, newSessionToken, parseCookies, presentedToken, resolveCaller, SESSION_COOKIE,
  sessionAlive, sessionCookie, SqlSessionStore, startSession, type Presented, type SessionRecord, type SessionStore,
} from './kernel/sessions.ts';
export { api, MANAGER, OFFICE, ONE_TIME, page, PUBLIC, roles, TECHNICIAN, token } from './policy/entry.ts';
export { policyByArea, policyTable } from './policy.ts';
export { handlers } from './handlers/index.ts';
export { createWebKernel, type WebKernel, type WebKernelOptions } from './web.ts';
export { sendResponse, serveNode, toRequest } from './node.ts';
export { EMIT_KEEP_MS, PgNotifyBus, roleSees, type BusFilter, type PgNotifyBusOptions, type Unsubscribe } from './events/bus.ts';
export { EVENTS_PATH, eventStreamHandler, HEARTBEAT_MS, sseFrame } from './events/stream.ts';
