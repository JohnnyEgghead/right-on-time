// SPDX-License-Identifier: AGPL-3.0-or-later
// The tech preview routes' state names (harness build only), in their own module: a value a server component imports from a
// 'use client' module is a client reference, so the routes read these here (as shell-preview/surface does).
export const SYNC_PREVIEWS = ['nosignal', 'old', 'count-synced', 'sent'] as const;
export const FRAME_PREVIEWS = ['today', 'today-offline'] as const;
export const JOB_PREVIEWS = ['success', 'loading', 'offline', 'not-on-phone', 'not-yours', 'done', 'no-one-home', 'canceled', 'on-site', 'menu', 'viewer', 'photo-none', 'photo-preview', 'photo-saved', 'finished'] as const;
export const NOTE_PREVIEWS = ['typing', 'empty', 'restored', 'saved-offline', 'discard'] as const;
export const FINISH_PREVIEWS = ['signed', 'editing', 'no-parts-list', 'invalid', 'confirming', 'restored'] as const;
export const WAITING_PREVIEWS = ['nothing', 'offline', 'sending', 'partial', 'refused', 'old'] as const;
