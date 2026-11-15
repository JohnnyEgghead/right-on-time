// SPDX-License-Identifier: AGPL-3.0-or-later
// Metro resolves an imported image to an asset module id.
declare module '*.jpg' {
  const assetId: number;
  export default assetId;
}
