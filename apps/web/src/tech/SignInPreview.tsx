// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// Harness build only (the shell-preview route tech-signin): SCR-TEC-01 on one of the frame's states, fixed.
import { TechSignIn } from './TechSignIn.tsx';
import { signInPreview, type SignInPreviewName } from './signin-preview-data.ts';

export function SignInPreview({ name }: { name: SignInPreviewName }) {
  return <TechSignIn {...signInPreview(name)} />;
}
