// SPDX-License-Identifier: AGPL-3.0-or-later
// The worker's alerts folder (SPECIFICATIONS SD-30, FR-HLTH-4; built under apps/worker/src/ because the image ships it).
// jobs.ts wires the alert.check event and the heartbeat job; the web handlers of the health area call runAlertChecks
// (API-160 Check now). The alert_setting rows are the seed's (F-444), defaults from @bw/domain alertSettingDefaults.
export { alertEmailWords, type CopyLanguage } from './copy.ts';
export { openAlert, runAlertChecks, showAlertEmailLink, type CheckEnv, type CheckReport } from './check.ts';
export { alertCheckHandler, ALERT_CHECK, giveUpAlertCheck, HEARTBEAT_EVERY_MS, startAlertJobs, writeHeartbeat } from './jobs.ts';
export { INFO_RULES, RULES, textGaveUpLink, type Rule, type RuleEnv, type Wanted } from './rules.ts';
