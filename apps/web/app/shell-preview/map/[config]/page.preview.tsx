// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): CMP-05 Map mounted the way the board, the live map and the technician map mount it
// (FR-MAP-1, P3-MAP-WEB), over any of the 3 branch files. ?branch=columbus|dayton|springfield (default columbus);
// ?fail=1 reads a file the server does not have, which is the "The map could not load" state;
// ?names=0 draws the shapes-only style (no lettering), which the F-452 label test compares the named map with;
// ?change=1 adds a control that changes the markers after ready. Never a release route.
import '../../../../src/shell/css/office.ts';
import { notFound } from 'next/navigation';
import { MAP_CONFIGS, mapFixture, type MapConfig } from '../../../../src/map/map-fixtures.ts';
import { isBranchId } from '../../../../src/map/map-model.ts';
import { MapChangeHarness } from '../../../../src/map/MapChangeHarness.tsx';
import { MapView } from '../../../../src/map/MapView.tsx';
import { Screen } from '../../../../src/shell/Surface.tsx';

export const dynamic = 'force-dynamic';

export default async function MapPreview({ params, searchParams }: { params: Promise<{ config: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { config } = await params;
  if (!(MAP_CONFIGS as readonly string[]).includes(config)) notFound();
  const q = await searchParams;
  const branch = q.branch ?? 'columbus';
  if (!isBranchId(branch)) notFound();
  const fx = mapFixture(config as MapConfig, branch);
  const failing = q.fail === '1';
  // ?change=1 adds a control that changes the markers after ready (F-451); the look cases do not use it.
  const View = q.change === '1' ? MapChangeHarness : MapView;
  return (
    <Screen screen="CMP-05" surface="SURF-OFC" noClock footer={false}>
      <div className={fx.variant === 'panel' ? 'bw-prev-panel' : 'bw-prev-card'} data-preview-map={config}>
        <View
          branch={branch}
          markers={fx.markers}
          routes={fx.routes}
          legend={fx.legend ? [fx.legend] : null}
          variant={fx.variant}
          altVisible={fx.variant === 'card'}
          {...(failing ? { file: 'missing.pmtiles' } : {})}
          {...(q.names === '0' ? { names: false } : {})}
        />
      </div>
    </Screen>
  );
}
