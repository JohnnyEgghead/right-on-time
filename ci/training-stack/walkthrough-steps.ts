// SPDX-License-Identifier: AGPL-3.0-or-later
// The reader of the dispatcher walkthrough (docs/public/walkthrough.md; FR-DIST-10, SC-04). The script file is the one source of the 10 tasks:
// the Playwright run (ci/training-stack/training.stack.ts) and the structure test (walkthrough.test.ts) both read their steps from it here.
// A step is a numbered line that starts with one of 6 verbs; the words in double quotes are what the app shows on the screen. Any text after
// the verb's own words is explanation for the reader and is ignored. A line that starts with no known verb is an error, never skipped.
import { readFileSync } from 'node:fs';
import path from 'node:path';

export type Step =
  | { verb: 'go'; path: string }
  | { verb: 'click'; name: string; beside?: string }
  | { verb: 'pick'; name: string }
  | { verb: 'see'; text: string }
  | { verb: 'type'; value: { kind: 'text'; text: string } | { kind: 'email' } | { kind: 'password' }; field: string }
  | { verb: 'choose'; name: string; field: string };

export interface Task {
  n: number;
  title: string;
  /** The on-screen words of the screen the task happens on. */
  screen: string;
  /** The on-screen name of the control the task is about. */
  control: string;
  steps: { n: number; line: string; step: Step }[];
}

export const WALKTHROUGH_PATH = 'docs/public/walkthrough.md';
export const TRAINING_SHEET_PATH = 'docs/public/training-sheet.md';
export const repoRoot = path.resolve(import.meta.dirname, '../..');

export function parseStep(text: string): Step {
  let m: RegExpExecArray | null;
  if ((m = /^Go to "([^"]+)"/.exec(text))) return { verb: 'go', path: m[1]! };
  if ((m = /^Click "([^"]+)" beside "([^"]+)"/.exec(text))) return { verb: 'click', name: m[1]!, beside: m[2]! };
  if ((m = /^Click "([^"]+)"/.exec(text))) return { verb: 'click', name: m[1]! };
  if ((m = /^Pick "([^"]+)"/.exec(text))) return { verb: 'pick', name: m[1]! };
  if ((m = /^See "([^"]+)"/.exec(text))) return { verb: 'see', text: m[1]! };
  if ((m = /^Type your work email in "([^"]+)"/.exec(text))) return { verb: 'type', value: { kind: 'email' }, field: m[1]! };
  if ((m = /^Type your password in "([^"]+)"/.exec(text))) return { verb: 'type', value: { kind: 'password' }, field: m[1]! };
  if ((m = /^Type "([^"]*)" in "([^"]+)"/.exec(text))) return { verb: 'type', value: { kind: 'text', text: m[1]! }, field: m[2]! };
  if ((m = /^Choose "([^"]+)" in "([^"]+)"/.exec(text))) return { verb: 'choose', name: m[1]!, field: m[2]! };
  throw new Error(`walkthrough: a step starts with no known verb (Go to, Click, Pick, See, Type, Choose): "${text}"`);
}

/** Reads the tasks from the walkthrough text. Throws on a malformed task header, a missing Screen or Control line, or a step out of number. */
export function parseWalkthrough(md: string): Task[] {
  const tasks: Task[] = [];
  let cur: Task | null = null;
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    let m: RegExpExecArray | null;
    if ((m = /^## Task (\d+)\. (.+)$/.exec(line))) {
      cur = { n: Number(m[1]), title: m[2]!, screen: '', control: '', steps: [] };
      tasks.push(cur);
    } else if (cur && (m = /^Screen: "([^"]+)"/.exec(line))) cur.screen = m[1]!;
    else if (cur && (m = /^Control: "([^"]+)"/.exec(line))) cur.control = m[1]!;
    else if (cur && (m = /^(\d+)\. (.+)$/.exec(line))) {
      const n = Number(m[1]);
      if (n !== cur.steps.length + 1) throw new Error(`walkthrough: Task ${cur.n} step ${n} is out of order (expected ${cur.steps.length + 1})`);
      cur.steps.push({ n, line: m[2]!, step: parseStep(m[2]!) });
    }
  }
  return tasks;
}

export function readWalkthrough(): Task[] {
  return parseWalkthrough(readFileSync(path.join(repoRoot, WALKTHROUGH_PATH), 'utf8'));
}

/** What the script must hold, as problems (empty = fine): 10 tasks in order, each with a screen it shows ("See") and a control it uses ("Click", "Pick" or "Choose"). */
export function problems(tasks: Task[]): string[] {
  const out: string[] = [];
  if (tasks.length !== 10) out.push(`expected 10 tasks, found ${tasks.length}`);
  tasks.forEach((t, i) => {
    const id = `Task ${t.n} (${t.title})`;
    if (t.n !== i + 1) out.push(`${id}: task numbers are not 1..10 in order`);
    if (t.steps.length === 0) out.push(`${id}: no steps`);
    if (!t.screen) out.push(`${id}: no Screen line`);
    if (!t.control) out.push(`${id}: no Control line`);
    if (t.screen && !t.steps.some((s) => s.step.verb === 'see' && s.step.text === t.screen)) out.push(`${id}: no step sees the screen "${t.screen}"`);
    const used = t.steps.some((s) => (s.step.verb === 'click' || s.step.verb === 'pick') && s.step.name === t.control);
    if (t.control && !used) out.push(`${id}: no step clicks or picks the control "${t.control}"`);
  });
  return out;
}
