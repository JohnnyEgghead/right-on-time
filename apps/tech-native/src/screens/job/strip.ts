// SPDX-License-Identifier: AGPL-3.0-or-later
// F-1234: the job screen's photo strip (CTL-TEC-04-10) and the thumbnail it shares with the finish screen (CTL-TEC-07-16), as the
// phone draws them. Platform-free, so the tests run these rules on node; JobScreen.tsx and Thumb.tsx call them.
//
// The strip has a row of its own under Add note and Add photo (kit 0.10, owner answer e5cafbd2, F-1371), so on an iPhone 16 Pro (402 pt)
// it is 352 pt wide (402 - 2 x 12 scroll padding - 2 x 1 group border - 2 x 12 row padding) and shows 4 thumbnails whole and a peek of
// the 5th. The photos run in the order both apps share (model.ts shownPhotos: the server's in the order taken, then the technician's own
// unsent ones), so a photo just added is the last one. The strip rests at its end, where the newest photos are (F-1234). Since kit 0.9
// (DK-117, F-1236) the strip is under its count, Photos (n), so the photos out of view are named.
//
// A sent photo's thumbnail is the server's small copy (API-175 size=thumb, UD-55; F-1235, P6-NATIVE-STEPS), not the whole file, which
// only the viewer reads. Until its image has loaded, a tile draws the placeholder under it: a photo still loading is a photo tile with
// the camera mark, never an empty one.

/** API-175's size of a photo read (UD-55; F-1235): `thumb`, the small copy every tile draws; `full`, the whole file, for the viewer only. */
export type PhotoSize = 'thumb' | 'full';

/** The server's address of a stored photo (API-175): the small copy (`?size=thumb`) for a tile, the whole file for the viewer. */
export const photoPath = (key: string, size: PhotoSize): string => `/api/v1/files/${encodeURIComponent(key)}${size === 'thumb' ? '?size=thumb' : ''}`;

/** A thumbnail's size and the gap between thumbnails (DK-117, kit 0.10: 72 x 54 pt, gap 8 pt). */
export const THUMB = { width: 72, height: 54, gap: 8 } as const;

/** The strip's content width for `n` thumbnails. */
export const stripContent = (n: number): number => (n > 0 ? n * THUMB.width + (n - 1) * THUMB.gap : 0);

/** The strip's x offset at rest: its end, so the newest photo is in view; 0 when every thumbnail fits or the strip is not laid out yet. */
export function stripRest(contentWidth: number, viewWidth: number): number {
  if (!(viewWidth > 0)) return 0;
  return Math.max(0, contentWidth - viewWidth);
}

export type ThumbImage = 'loading' | 'loaded' | 'failed';

/** What a thumbnail draws: its image while it has a source that has not failed, and the placeholder under it until that image has loaded. */
export function thumbLayers(hasSource: boolean, image: ThumbImage): { image: boolean; placeholder: boolean } {
  const drawn = hasSource && image !== 'failed';
  return { image: drawn, placeholder: !drawn || image !== 'loaded' };
}
