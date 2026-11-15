// SPDX-License-Identifier: AGPL-3.0-or-later
// The customer the job page's 3 dialogs write for when the customer page hosts them (SCR-OFC-35, -36, -37; F-671), from API-35's read.
import type { DialogCustomer } from '../job/Dialogs.tsx';
import { branchById } from '../shell/branches.ts';
import { formatPhone } from './model.ts';
import type { Detail } from './types.ts';

export function dialogCustomer(d: Detail): DialogCustomer {
  return {
    id: d.id, name: d.name, mobile: d.contact.mobile === null ? null : formatPhone(d.contact.mobile), language: d.language, zone: d.zone,
    officeZone: branchById(d.branch).zone, equipment: d.equipment,
  };
}

/** The states a hosted dialog is drawn in (DK-87's Text customer, Add note and Add or edit equipment tiles). */
export const HOSTED_STATES = [
  'text-empty', 'text-typing', 'text-too-long', 'text-sending', 'text-refused',
  'note-empty', 'note-typing', 'note-saving',
  'equipment-adding', 'equipment-editing', 'equipment-saving',
] as const;
export type HostedState = (typeof HOSTED_STATES)[number];

