// SPDX-License-Identifier: AGPL-3.0-or-later
// Spike S1: a standalone server build, so the image runs `node server.js` with no dev dependencies.
const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,
};

export default nextConfig;
