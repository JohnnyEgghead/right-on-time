// SPDX-License-Identifier: AGPL-3.0-or-later
// The job screens' routes (SD-47 Native app: a stack per tab, sheets over them). Job and Finish job sit on Today's stack (the frames
// draw them over the Today tab), Waiting to send on Me's (its back button reads Me), and the note, photo and status sheets on the
// root stack, over the tabs. routes.tsx registers the components under these names.
import type { NavigationProp, ParamListBase } from '@react-navigation/native';
import type { StatusSheetParams } from '../today/Sheets.tsx';

export type StatusKind = 'on_my_way' | 'arrived' | 'no_one_home';

export interface JobRoutes extends ParamListBase {
  /** `history`: opened by See history (CTL-TEC-02-13), at the job's service history. */
  Job: { jobNumber: number; history?: boolean };
  Finish: { jobNumber: number };
  Waiting: undefined;
  JobNote: { jobNumber: number };
  JobPhoto: { jobNumber: number };
  JobStatus: StatusSheetParams;
}

/** SCR-TEC-04 for a job from any tab (F-1072 item 2: CTL-TEC-15-02, CTL-TEC-15-10, CTL-TEC-08-04): Job sits on Today's stack, over Today. */
export const openJob = (nav: NavigationProp<ParamListBase>, jobNumber: number): void =>
  nav.navigate('Today', { screen: 'Job', params: { jobNumber }, initial: false });

/** CTL-CMP-10-02: the waiting count opens SCR-TEC-09 from any tab (it sits on Me's stack). */
export const openWaiting = (nav: NavigationProp<ParamListBase>): void => nav.navigate('Me', { screen: 'Waiting', initial: false });
