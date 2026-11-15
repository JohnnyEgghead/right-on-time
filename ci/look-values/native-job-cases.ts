// SPDX-License-Identifier: AGPL-3.0-or-later
// G-LOOK-PARITY cases of the native job screens (P6-NATIVE-JOB Acceptance, look clause: SCR-TEC-04 to -07 and -09 against DK-117's
// frames, native values read from the view hierarchy, in each state its frames show, light theme). Joined to NATIVE_CASES by
// native-compare.ts; each case's state is the dump the job screens write (apps/tech-native/src/screens/job/*: useLookDump).
// The frames' sample words (Harold's equipment, the seeded notes, the waiting items' texts) are the test's own data on the phone, so
// a text pair whose words are the test's is marked `data` (its width is not compared) or compared as `type` (no box) where its
// height follows the words too. Each frame's details tiles (data-bw-tile) are drawn at the details strip's width: a box there is
// compared as the room it leaves in its parent (`fill`).
import type { NativeCase, NativePair } from './native-compare.ts';

const cap = (c: string) => `[data-bw-cap="${c}"] .screen`;
const tile = (t: string) => `[data-bw-tile="${t}"] > .b`;
const WORDS = 'the test\'s own words on the phone, not the frame\'s sample words';

/** The native navigation bar (.bar2: back button, large title, the line under it). */
const bar = (id: string, sub: boolean): NativePair[] => [
  { frame: '.bar2 .navrow', native: `${id}.bar.nav`, kind: 'box' },
  { frame: '.bar2 .backb', native: `${id}.bar.back`, kind: 'box' },
  { frame: '.bar2 .backb .ic', native: `${id}.bar.back.icon`, kind: 'icon' },
  { frame: '.bar2 .backb', native: `${id}.bar.back.text`, kind: 'type' },
  { frame: '.bar2 h1', native: `${id}.bar.title`, kind: 'text', data: WORDS },
  ...(sub ? [{ frame: '.bar2 .sub', native: `${id}.bar.sub`, kind: 'type' as const }] : []),
];

/** A settings group of 1 row with a bold line and a small line (.grp > .row > .tx > b, small). */
const groupRow = (frame: string, id: string): NativePair[] => [
  { frame, native: `${id}.grp`, kind: 'box', data: WORDS, sum: 'the sum of its rows, each compared' },
  { frame: `${frame} > .row`, native: `${id}.row`, kind: 'box', data: WORDS, sum: 'its 2 text lines, each compared' },
  { frame: `${frame} > .row b`, native: `${id}.b`, kind: 'text', data: WORDS },
  { frame: `${frame} > .row small`, native: `${id}.small`, kind: 'text', data: WORDS },
];

const ghead = (frame: string, id: string): NativePair => ({ frame, native: id, kind: 'text', data: 'the heading spans the screen; its words are compared by their face' });

/** A secondary button (.sbtn) with an icon and its label. */
const sbtn = (frame: string, id: string, icon: boolean, label: 'text' | 'type' = 'text'): NativePair[] => [
  { frame, native: id, kind: 'box' },
  ...(icon ? [{ frame: `${frame} .ic`, native: `${id}.icon`, kind: 'icon' as const }] : []),
  { frame: `${frame} span`, native: `${id}.text`, kind: label },
];

const J4 = cap('SCR-TEC-04 Job, iPhone: Success');
const J5 = cap('SCR-TEC-05 Add note, iPhone: Typing');
const J6 = cap('SCR-TEC-06 Add photo, iPhone: Preview');
const J7 = cap('SCR-TEC-07 Finish job, iPhone: Editing');
const J9 = cap('SCR-TEC-09 Waiting to send, iPhone: Waiting, offline');
const N = '.scroll > ';

export const JOB_CASES: NativeCase[] = [
  {
    name: 'SCR-TEC-04 Success (the main frame)', state: 'job', root: J4,
    pairs: [
      ...bar('job', true),
      { frame: '.bar2 .sub .st', native: 'job.bar.status', kind: 'box' },
      { frame: '.bar2 .sub .st', native: 'job.bar.status.text', kind: 'type' },
      { frame: `${N}.acts`, native: 'job.acts', kind: 'box' },
      { frame: '.acts .pbtn.dir', native: 'job.dir', kind: 'box' },
      { frame: '.acts .pbtn.dir .ic', native: 'job.dir.icon', kind: 'icon' },
      { frame: '.acts .pbtn.dir span', native: 'job.dir.text', kind: 'text' },
      { frame: '.acts .pbtn.dir small', native: 'job.dir.minutes', kind: 'text', data: 'the drive minutes of the test\'s route' },
      { frame: '.acts .pbtn:not(.dir)', native: 'job.call', kind: 'box' },
      { frame: '.acts .pbtn:not(.dir) .ic', native: 'job.call.icon', kind: 'icon' },
      { frame: '.acts .pbtn:not(.dir) span', native: 'job.call.text', kind: 'text' },
      { frame: `${N}.next`, native: 'job.cnote.card', kind: 'box', sum: 'the note box inside it, compared' },
      { frame: '.next .notebox', native: 'job.cnote', kind: 'box', data: WORDS, sum: 'its 2 text lines, each compared' },
      { frame: '.next .notebox b', native: 'job.cnote.title', kind: 'text' },
      { frame: '.next .notebox', native: 'job.cnote.text', kind: 'type' },
      ghead(`${N}.ghead:nth-child(3)`, 'job.ghead.eq'),
      ...groupRow(`${N}.grp:nth-child(4)`, 'job.eq'),
      ghead(`${N}.ghead:nth-child(5)`, 'job.ghead.hist'),
      ...groupRow(`${N}.grp:nth-child(6)`, 'job.hist'),
      ghead(`${N}.ghead:nth-child(7)`, 'job.ghead.notes'),
      { frame: `${N}.grp:nth-child(8)`, native: 'job.notes.grp', kind: 'box', sum: 'the sum of its rows, each compared' },
      { frame: `${N}.grp:nth-child(8) > .row:first-child`, native: 'job.note.row', kind: 'box', data: WORDS, sum: 'its 2 text lines, each compared' },
      { frame: `${N}.grp:nth-child(8) > .row:first-child b`, native: 'job.note.b', kind: 'text', data: WORDS },
      { frame: `${N}.grp:nth-child(8) > .row:first-child small`, native: 'job.note.small', kind: 'text', data: WORDS },
      // Kit 0.10 (owner answer e5cafbd2, F-1371): Add note and Add photo share the row above the photos; Photos has the group's last row.
      { frame: `${N}.grp:nth-child(8) > .row.adds`, native: 'job.adds.row', kind: 'box' },
      { frame: `${N}.grp:nth-child(8) > .row:last-child`, native: 'job.media.row', kind: 'box' },
      // Kit 0.9 (F-1236): the count, Photos (n), over the strip; kit 0.10: 72 x 54 tiles 8 apart in a row of their own, 4 in view and a peek of the 5th.
      { frame: '.tx.phs', native: 'job.phs', kind: 'box', fill: { frame: `${N}.grp:nth-child(8) > .row:last-child`, native: 'job.media.row' } },
      { frame: '.tx.phs small', native: 'job.phs.count', kind: 'text', data: 'the count of the test\'s own photos (the frame shows 3)' },
      { frame: '.tx.phs .strip .pv2:nth-child(1)', native: 'job.thumb', kind: 'box' },
      ...sbtn(`${N}.grp:nth-child(8) .sbtn:first-child`, 'job.addnote', true),
      ...sbtn(`${N}.grp:nth-child(8) .sbtn:last-child`, 'job.addphoto', true, 'type'),
      // Kit 0.10 (owner answer d6bfc18c, DK-58): On my way and the row under it sit in the bar pinned above the tab bar (native job.pin: its
      // 12 pt side padding is the scroll's, so each fills the bar's room, as it filled the scroll's).
      { frame: `${N}a.omw`, native: 'job.omw', kind: 'box' },
      { frame: `${N}a.omw`, native: 'job.omw', kind: 'box', fill: { frame: '.scroll', native: 'job.pin' } },
      { frame: `${N}.acts2`, native: 'job.acts2', kind: 'box', fill: { frame: '.scroll', native: 'job.pin' } },
      { frame: `${N}a.omw .ic`, native: 'job.omw.icon', kind: 'icon' },
      { frame: `${N}a.omw span`, native: 'job.omw.text', kind: 'text' },
      { frame: `${N}.acts2`, native: 'job.acts2', kind: 'box' },
      ...sbtn('.acts2 .sbtn:nth-child(1)', 'job.arrived', true),
      ...sbtn('.acts2 .sbtn:nth-child(2)', 'job.noh', false),
      ...sbtn('.acts2 .sbtn:nth-child(3)', 'job.finish', false),
    ],
  },
  {
    name: 'SCR-TEC-04 Unsaved note draft (control details)', state: 'job-draft', root: tile('Unsaved note draft'),
    pairs: [{ frame: '.lnk', native: 'job.draft', kind: 'type' }],
  },
  {
    name: 'SCR-TEC-05 Typing (the main frame)', state: 'note-typing', root: `${J5} .nsheet`,
    pairs: [
      { frame: '.sbar3', native: 'note.bar', kind: 'box' },
      { frame: '.sbar3 .tb:not(.strong)', native: 'note.discard', kind: 'box' },
      { frame: '.sbar3 .tb:not(.strong)', native: 'note.discard.text', kind: 'type' },
      { frame: '.sbar3 b', native: 'note.title', kind: 'text' },
      { frame: '.sbar3 .tb.strong', native: 'note.save', kind: 'box' },
      { frame: '.sbar3 .tb.strong', native: 'note.save.text', kind: 'type' },
      { frame: '.ta', native: 'note.ta', kind: 'box' },
      { frame: '.ta', native: 'note.value', kind: 'face' },
      { frame: '.hint', native: 'note.kept', kind: 'box' },
      { frame: '.hint .ic', native: 'note.kept.icon', kind: 'icon' },
      { frame: '.hint', native: 'note.kept.text', kind: 'type' },
    ],
  },
  {
    name: 'SCR-TEC-06 Preview (the main frame)', state: 'photo-preview', root: `${J6} .nsheet`,
    pairs: [
      { frame: '.sbar3', native: 'photo.bar', kind: 'box' },
      { frame: '.sbar3 .tb', native: 'photo.cancel', kind: 'box' },
      { frame: '.sbar3 .tb', native: 'photo.cancel.text', kind: 'type' },
      { frame: '.sbar3 b', native: 'photo.title', kind: 'text' },
      { frame: '.pv2', native: 'photo.preview', kind: 'box' },
      { frame: '.b2', native: 'photo.btns', kind: 'box' },
      { frame: '.b2 .nbtn:not(.pri)', native: 'photo.retake', kind: 'box' },
      { frame: '.b2 .nbtn:not(.pri) .ic', native: 'photo.retake.icon', kind: 'icon' },
      { frame: '.b2 .nbtn:not(.pri)', native: 'photo.retake.text', kind: 'type' },
      { frame: '.b2 .nbtn.pri', native: 'photo.save', kind: 'box' },
      { frame: '.b2 .nbtn.pri .ic', native: 'photo.save.icon', kind: 'icon' },
      { frame: '.b2 .nbtn.pri', native: 'photo.save.text', kind: 'type' },
    ],
  },
  {
    name: 'SCR-TEC-06 No photo (control details)', state: 'photo-none', root: tile('No photo'),
    pairs: [
      { frame: '.nbtn.pri', native: 'photo.take', kind: 'box', fill: { frame: '', native: 'photo.body' } },
      { frame: '.nbtn.pri .ic', native: 'photo.take.icon', kind: 'icon' },
      { frame: '.nbtn.pri', native: 'photo.take.text', kind: 'type' },
    ],
  },
  {
    name: 'SCR-TEC-06 Permission denied (control details)', state: 'photo-denied', root: tile('Permission denied'),
    pairs: [
      { frame: '.errbox', native: 'photo.denied', kind: 'box', fill: { frame: '', native: 'photo.body' }, sum: 'its text lines, each compared by face' },
      { frame: '.errbox .ic', native: 'photo.denied.icon', kind: 'icon' },
      { frame: '.errbox > span', native: 'photo.denied.text', kind: 'type' },
      { frame: '.errbox .lnk', native: 'photo.settings', kind: 'type' },
    ],
  },
  {
    name: 'SCR-TEC-07 Editing (the main frame)', state: 'finish-editing', root: J7,
    pairs: [
      ...bar('fin', true),
      ghead(`${N}.ghead:nth-child(1)`, 'fin.ghead.work'),
      { frame: `${N}.grp:nth-child(2)`, native: 'fin.work.grp', kind: 'box', sum: 'the sum of its rows, each compared' },
      { frame: `${N}.grp:nth-child(2) > .row:first-child`, native: 'fin.line.row', kind: 'box' },
      { frame: `${N}.grp:nth-child(2) > .row:first-child b`, native: 'fin.line.value', kind: 'face' },
      { frame: `${N}.grp:nth-child(2) .navbtn`, native: 'fin.line.remove', kind: 'box' },
      { frame: `${N}.grp:nth-child(2) .navbtn .ic`, native: 'fin.line.remove.icon', kind: 'icon' },
      { frame: `${N}.grp:nth-child(2) > a.row`, native: 'fin.addline', kind: 'box' },
      { frame: `${N}.grp:nth-child(2) > a.row > .ic`, native: 'fin.addline.icon', kind: 'icon' },
      { frame: `${N}.grp:nth-child(2) > a.row .lnk`, native: 'fin.addline.text', kind: 'text' },
      ghead(`${N}.ghead:nth-child(3)`, 'fin.ghead.parts'),
      { frame: `${N}.grp:nth-child(4)`, native: 'fin.parts.grp', kind: 'box', sum: 'the sum of its rows, each compared' },
      { frame: `${N}.grp:nth-child(4) > .row:first-child`, native: 'fin.find', kind: 'box' },
      { frame: `${N}.grp:nth-child(4) > .row:first-child > .ic`, native: 'fin.find.icon', kind: 'icon' },
      { frame: `${N}.grp:nth-child(4) > .row:first-child small`, native: 'fin.find.value', kind: 'face' },
      { frame: `${N}.grp:nth-child(4) > .row:last-child`, native: 'fin.noparts', kind: 'box' },
      { frame: `${N}.grp:nth-child(4) > .row:last-child b`, native: 'fin.noparts.text', kind: 'text' },
      { frame: `${N}.grp:nth-child(4) .switch`, native: 'fin.noparts.switch', kind: 'box' },
      ghead(`${N}.ghead:nth-child(5)`, 'fin.ghead.labor'),
      ...groupRow(`${N}.grp:nth-child(6)`, 'fin.labor'),
      ghead(`${N}.ghead:nth-child(7)`, 'fin.ghead.sig'),
      { frame: `${N}.sigpad`, native: 'fin.sig', kind: 'box' },
      { frame: `${N}.sigpad`, native: 'fin.sig.text', kind: 'type' },
      { frame: `${N}a.primary`, native: 'fin.finish', kind: 'box' },
      { frame: `${N}a.primary .ic`, native: 'fin.finish.icon', kind: 'icon' },
      { frame: `${N}a.primary span`, native: 'fin.finish.text', kind: 'text' },
      { frame: `${N}.omwnote`, native: 'fin.finishNote', kind: 'text' },
    ],
  },
  {
    name: 'SCR-TEC-07 A part row (control details)', state: 'finish-part', root: tile('A part row'),
    pairs: [
      { frame: '.grp', native: 'fin.part.grp', kind: 'box', fill: { frame: '', native: 'fin.scroll' }, sum: 'its row, compared' },
      { frame: '.row', native: 'fin.part.row', kind: 'box', fill: { frame: '.grp', native: 'fin.part.grp' }, sum: 'its 2 text lines, each compared' },
      { frame: '.row .tx b', native: 'fin.part.name', kind: 'type' },
      { frame: '.row small', native: 'fin.part.code', kind: 'text', data: WORDS },
      { frame: '.stepn', native: 'fin.part.qty', kind: 'box' },
      { frame: '.stepn > span:first-child', native: 'fin.part.less', kind: 'box' },
      { frame: '.stepn > span:first-child', native: 'fin.part.less.text', kind: 'type' },
      { frame: '.stepn > b', native: 'fin.part.n', kind: 'text' },
      { frame: '.stepn > span:last-child', native: 'fin.part.more', kind: 'box' },
      { frame: '.stepn > span:last-child', native: 'fin.part.more.text', kind: 'type' },
      { frame: '.trailc > .lnk', native: 'fin.part.remove', kind: 'type' },
    ],
  },
  {
    name: 'SCR-TEC-07 Signed (control details)', state: 'finish-signed', root: tile('Signed'),
    pairs: [
      { frame: '.row', native: 'fin.signed', kind: 'box', fill: { frame: '', native: 'fin.scroll' } },
      { frame: '.row b', native: 'fin.signed.text', kind: 'type' },
      { frame: '.row .lnk', native: 'fin.signed.clear', kind: 'type' },
    ],
  },
  {
    name: 'SCR-TEC-07 Confirming (control details)', state: 'finish-confirm', root: tile('Confirming'),
    pairs: [
      { frame: '> b', native: 'fin.confirm.title', kind: 'type' },
      { frame: '> span', native: 'fin.confirm.why', kind: 'type' },
      { frame: '> .nbtn.pri', native: 'fin.confirm.ok', kind: 'box', fill: { frame: '', native: 'fin.confirm' } },
      { frame: '> .nbtn.pri', native: 'fin.confirm.ok.text', kind: 'type' },
      { frame: '> .nbtn:not(.pri)', native: 'fin.confirm.back', kind: 'box', fill: { frame: '', native: 'fin.confirm' } },
      { frame: '> .nbtn:not(.pri)', native: 'fin.confirm.back.text', kind: 'type' },
    ],
  },
  {
    name: 'SCR-TEC-07 Invalid (control details)', state: 'finish-invalid', root: tile('Invalid'),
    pairs: [
      { frame: '.errbox', native: 'fin.err', kind: 'box', fill: { frame: '', native: 'fin.scroll' }, sum: 'its words wrap at the phone\'s width, the tile is drawn at the details strip\'s; its text is compared by face' },
      { frame: '.errbox .ic', native: 'fin.err.icon', kind: 'icon' },
      { frame: '.errbox span', native: 'fin.err.text', kind: 'type' },
    ],
  },
  {
    name: 'SCR-TEC-09 Waiting, offline (the main frame)', state: 'waiting-offline', root: J9,
    pairs: [
      ...bar('wait', false),
      { frame: `${N}.nosig`, native: 'wait.nosig', kind: 'box', sum: 'its 2 text lines, each compared' },
      { frame: '.nosig .bi', native: 'wait.nosig.badge', kind: 'box' },
      { frame: '.nosig .bi .ic', native: 'wait.nosig.icon', kind: 'icon' },
      { frame: '.nosig b', native: 'wait.nosig.title', kind: 'text' },
      { frame: '.nosig small', native: 'wait.nosig.text', kind: 'text' },
      { frame: `${N}.grp`, native: 'wait.list', kind: 'box', sum: 'the sum of its rows, each compared' },
      { frame: `${N}.grp > .row:first-child`, native: 'wait.row', kind: 'box', data: WORDS, sum: 'its 2 text lines, each compared' },
      { frame: `${N}.grp > .row:first-child b`, native: 'wait.row.b', kind: 'text', data: WORDS },
      { frame: `${N}.grp > .row:first-child small`, native: 'wait.row.small', kind: 'type' },
      { frame: `${N}.grp > .row:first-child .wait`, native: 'wait.row.state', kind: 'text' },
      { frame: `${N}.grp > .row:nth-child(2)`, native: 'wait.row2', kind: 'box', data: WORDS, sum: 'its 2 text lines, each compared' },
      { frame: `${N}a.sbtn`, native: 'wait.send', kind: 'box' },
      { frame: `${N}a.sbtn .ic`, native: 'wait.send.icon', kind: 'icon' },
      { frame: `${N}a.sbtn span`, native: 'wait.send.text', kind: 'text' },
      { frame: `${N}.hint.c`, native: 'wait.why', kind: 'text' },
      { frame: `${N}.infobox`, native: 'wait.how', kind: 'box', sum: 'its text, compared' },
      { frame: `${N}.infobox .ic`, native: 'wait.how.icon', kind: 'icon' },
      { frame: `${N}.infobox span`, native: 'wait.how.text', kind: 'text' },
    ],
  },
];
