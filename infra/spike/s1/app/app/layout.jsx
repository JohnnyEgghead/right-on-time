// SPDX-License-Identifier: AGPL-3.0-or-later
export const metadata = { title: 'Spike S1' };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
