// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// CMP-15 with its own kit slice, for the shared Page not found page under the booking site (SCR-CUS-07's unknown page, DK-133): loaded on demand by
// SharedPages so the booking slice (DK-66 to DK-68) reaches only that page.
import './css/booking.ts';
import '../../styles/app/booking-frame.css';
import { BRANCHES } from './branches.ts';
import { BookingHeader } from './Headers.tsx';

export default function BookingSiteHeader() {
  return <BookingHeader branch={BRANCHES[0]!} />;
}
