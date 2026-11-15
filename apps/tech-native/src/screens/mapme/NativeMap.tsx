// SPDX-License-Identifier: AGPL-3.0-or-later
// CMP-05 Map on the native app (P6-NATIVE-MAP-ME; CTL-TEC-08-01, CTL-TEC-15-01, CTL-CMP-05-01, CTL-CMP-05-04; SD-34): @maplibre/maplibre-react-native
// over the branch file kept in the app's storage, drawing the street, place and water names from the bundled glyph set. The numbered stops and the
// route are layers of the same style. The credit "(c) OpenStreetMap" is a link over the map's corner (HC-04). It tells the tests what it drew:
// the status line (an accessibility label on `<id>.status`) counts the rendered name features by kind, so a blank map or one with no names is
// not mistaken for a map. Nothing here reaches the network: the style names only files on the phone (map-style.ts remoteUrls).
import { Camera, Map, Marker, type CameraRef, type MapRef } from '@maplibre/maplibre-react-native';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Linking, Pressable, Settings, StyleSheet, View } from 'react-native';
import { lk } from '../../ui/look.ts';
import { color } from '../../ui/tokens.ts';
import { useT } from '../../ui/intl.tsx';
import { Icon } from '../../ui/Icon.tsx';
import type { NativeIcon } from '../../ui/icon-paths.ts';
import { fetchMapFile, keptMapUri, mapAssetsUri } from './map-file.ts';
import { nativeMapStyle, NAME_LAYER_IDS } from './map-style.ts';
import { BRANCH_MAPS, OSM_COPYRIGHT_URL, type BranchId, type LngLat, type MapLeg, type MapStop } from './model.ts';
import { c, T } from './parts.tsx';

/** The known-bad run of the XCUITest (-bwMapNames 0): the style without its lettering, which the status line must report as no names. */
const NAMES_OFF = process.env.EXPO_PUBLIC_BW_RIG === '1' && String(Settings.get('bwMapNames') ?? '') === '0';

/** `missing`: no copy and no signal (CTL-TEC-15: the map needs signal). `failed`: the file did not download with signal. `broken`: the style would not load (CTL-CMP-05-01). */
type FileState = { kind: 'checking' } | { kind: 'ready'; uri: string } | { kind: 'missing' } | { kind: 'failed' } | { kind: 'broken' };

export interface NativeMapProps {
  id: string;
  branch: BranchId;
  /** The server origin the branch file comes from (API-106). */
  origin: string;
  stops: readonly MapStop[];
  legs: readonly MapLeg[];
  /** Each change of this number frames the stops again (CTL-TEC-15-05). */
  fitKey: number;
  /** Whether the app may fetch the branch file now (signal). */
  online: boolean;
  /** The map in words (the screen's text alternative names the stops). */
  label: string;
  /** The box's height (DK-117: 300 px; Directions' map is 216 px, so 3 steps show above the tab bar). */
  height?: number;
  /** CTL-TEC-08-01: the marker at the next turn, with its arrow (P6-NATIVE-STEPS). */
  turn?: { at: LngLat; icon: NativeIcon } | null;
  /** CTL-TEC-08-01, CTL-TEC-08-06: each new key centers the map on `at` (a picked step's turn). */
  focus?: { at: LngLat; key: number } | null;
  /** Drawn over the map's corner (CTL-TEC-08-07 Show the whole route). */
  children?: ReactNode;
}

function boundsOf(points: readonly LngLat[]): [number, number, number, number] | null {
  if (points.length === 0) return null;
  const lngs = points.map((p) => p[0]);
  const lats = points.map((p) => p[1]);
  return [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];
}

export function NativeMap(props: NativeMapProps) {
  const t = useT();
  const [file, setFile] = useState<FileState>(() => {
    const uri = keptMapUri(props.branch);
    return uri ? { kind: 'ready', uri } : { kind: 'checking' };
  });
  // The branch file comes once, with signal; a phone that has it draws the map with none.
  useEffect(() => {
    if (file.kind === 'ready' || file.kind === 'broken') return;
    if (!props.online) {
      setFile({ kind: 'missing' });
      return;
    }
    let live = true;
    fetchMapFile(props.origin, props.branch).then(
      (uri) => live && setFile({ kind: 'ready', uri }),
      // F-1070: with signal, a file that did not come is a map that could not load, not a phone that lacks signal.
      () => live && setFile({ kind: 'failed' }),
    );
    return () => {
      live = false;
    };
  }, [file.kind, props.online, props.origin, props.branch]);

  return (
    <View {...lk(props.id, props.height !== undefined ? [s.box, { height: props.height }] : s.box)} accessible={false} accessibilityLabel={props.label}>
      {file.kind === 'ready' ? <DrawnMap {...props} tiles={file.uri} onFailed={() => setFile({ kind: 'broken' })} /> : null}
      {file.kind === 'missing' ? (
        <View {...lk(`${props.id}.need`, s.need)}>
          <Icon name="signal" size={18} color={color.ink500} />
          <T style={s.needText}>{t('tech.map.needSignal')}</T>
        </View>
      ) : null}
      {file.kind === 'failed' || file.kind === 'broken' ? (
        <View {...lk(`${props.id}.failed`, s.need)} accessible accessibilityRole="image" accessibilityLabel={t('map.failed')}>
          <Icon name="map" size={18} color={color.ink500} />
          <T style={s.needText}>{t('map.failed')}</T>
        </View>
      ) : null}
      {/* F-1640: the link's accessibility frame is 44 pt tall (the transparent hit box); the white pill inside keeps the credit's look. */}
      <Pressable {...lk(`${props.id}.osm`, s.osmHit)} onPress={() => void Linking.openURL(OSM_COPYRIGHT_URL)} accessibilityRole="link" accessibilityLabel={t('map.credit')}>
        <View {...lk(`${props.id}.osm.pill`, s.osm)}>
          <T lkId={`${props.id}.osm.text`} style={s.osmText}>{t('map.credit')}</T>
        </View>
      </Pressable>
      {file.kind === 'ready' ? props.children : null}
    </View>
  );
}

function DrawnMap(props: NativeMapProps & { tiles: string; onFailed: () => void }) {
  const assets = mapAssetsUri();
  const mapRef = useRef<MapRef>(null);
  const camera = useRef<CameraRef>(null);
  const regionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState('drawing');
  const style = useMemo(
    () => nativeMapStyle({ tiles: props.tiles, assets: assets ?? '' }, props.stops, props.legs, assets !== null && !NAMES_OFF),
    [props.tiles, assets, props.stops, props.legs],
  );
  const view = BRANCH_MAPS[props.branch];
  const box = useMemo(() => boundsOf([...props.stops.map((p) => p.at), ...props.legs.flatMap((l) => [l.from, l.to])]), [props.stops, props.legs]);

  const turnAt = useRef<LngLat | null>(props.turn?.at ?? null);
  turnAt.current = props.turn?.at ?? null;
  const count = useCallback(async () => {
    const map = mapRef.current;
    if (!map) return;
    try {
      const read = async (layers: readonly string[]) => (await map.queryRenderedFeatures({ layers: [...layers] })).length;
      const [streets, places, water, shields, stops, base] = await Promise.all([
        read(NAME_LAYER_IDS.street), read(NAME_LAYER_IDS.place), read(NAME_LAYER_IDS.water), read(NAME_LAYER_IDS.shield),
        read(['bw-stops-disc']), read(['roads_major', 'roads_minor_service', 'earth', 'buildings']),
      ]);
      // P6-NATIVE-STEPS: where the map is centered and the next-turn marker it holds, so the test can tell a picked step centered it.
      const [lng, lat] = await map.getCenter();
      const turn = turnAt.current ? `${turnAt.current[0]},${turnAt.current[1]}` : 'none';
      setStatus(`streets=${streets} places=${places} water=${water} shields=${shields} stops=${stops} base=${base} center=${lng.toFixed(5)},${lat.toFixed(5)} turn=${turn}`);
    } catch (e) {
      setStatus(`error ${(e as Error).name}`);
    }
  }, []);

  // Tiles and lettering arrive after the first full render; the count is read again a few times while the map settles.
  useEffect(() => {
    const timers = [1500, 3500, 7000].map((ms) => setTimeout(() => void count(), ms));
    return () => timers.forEach(clearTimeout);
  }, [count, style]);

  useEffect(() => {
    if (props.fitKey > 0 && box) camera.current?.fitBounds(box, { padding: { top: 40, right: 40, bottom: 40, left: 40 }, duration: 300 });
  }, [props.fitKey, box]);

  // CTL-TEC-08-06: a picked step centers the map on its turn, close enough to read the streets there.
  const focusKey = props.focus?.key ?? 0;
  const focusAt = props.focus?.at;
  useEffect(() => {
    if (focusKey > 0 && focusAt) camera.current?.easeTo({ center: [focusAt[0], focusAt[1]], zoom: 16, duration: 300 });
  }, [focusKey, focusAt]);

  return (
    <>
      {/* F-1200 (FR-LANG-1): the app labels the map itself, from the catalog in the in-app language. MapLibre's own accessibility labels
          ("Map", and "About this map" on its hidden attribution button) come from the framework's strings in the phone's language, never the
          app's choice; this 1 element (the drawn map, labelled props.label) takes their place, and the app's own credit link
          (<id>.osm, map.credit) is the map's attribution. Touches still reach the map: accessibility does not change hit testing. */}
      <View style={s.map} accessible accessibilityRole="image" accessibilityLabel={props.label}>
        <Map
          ref={mapRef}
          style={s.map}
          mapStyle={style as never}
          attribution={false}
          logo={false}
          compass={false}
          onDidFailLoadingMap={() => {
            setStatus('error map failed to load');
            props.onFailed();
          }}
          onDidFinishRenderingMapFully={() => void count()}
          onRegionDidChange={() => {
            if (regionTimer.current) clearTimeout(regionTimer.current);
            regionTimer.current = setTimeout(() => void count(), 1200);
          }}
        >
          <Camera
            ref={camera}
            initialViewState={box && (box[0] !== box[2] || box[1] !== box[3])
              ? { bounds: box, padding: { top: 40, right: 40, bottom: 40, left: 40 } }
              : { center: box ? [box[0], box[1]] : [...view.center], zoom: box ? 14 : view.zoom }}
            maxBounds={[...view.bbox]}
          />
          {props.turn ? (
            <Marker id="bw-turn" lngLat={[props.turn.at[0], props.turn.at[1]]}>
              <View style={s.turn} accessible={false}>
                <Icon name={props.turn.icon} size={17} color={TURN_INK} strokeWidth={2.6} />
              </View>
            </Marker>
          ) : null}
        </Map>
      </View>
      {/* F-1088: the read-out is for the XCUITest only; a screen reader finds it in a rig bundle (EXPO_PUBLIC_BW_RIG=1) and never in a shipped one. */}
      {process.env.EXPO_PUBLIC_BW_RIG === '1' ? <T lkId={`${props.id}.status`} style={s.status} accessibilityLabel={status}>{status}</T> : null}
    </>
  );
}

/** The next-turn marker (DK-117 nmap8): a white disc with a teal-700 ring, the turn arrow in teal-800. */
const TURN_INK = '#0c4b5d';

const s = StyleSheet.create({
  turn: { width: 29, height: 29, borderRadius: 14.5, backgroundColor: color.white, borderWidth: 3, borderColor: '#0f5e73', alignItems: 'center', justifyContent: 'center' },
  box: { height: 300, backgroundColor: c.ink100, overflow: 'hidden' },
  map: { ...StyleSheet.absoluteFill },
  status: { position: 'absolute', top: 0, left: 0, width: 1, height: 1, opacity: 0.01, fontSize: 1 },
  need: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', rowGap: 8 },
  needText: { fontSize: 14, color: color.ink600 },
  osmHit: { position: 'absolute', left: 8, bottom: -7.2, justifyContent: 'center', minHeight: 44, paddingVertical: 13.2 },
  osm: { backgroundColor: 'rgba(255,255,255,0.9)', borderRadius: 5, paddingVertical: 1, paddingHorizontal: 6 },
  osmText: { fontFamily: 'Inter-W400', fontSize: 11, lineHeight: 15.4, color: c.ink700, textDecorationLine: 'underline' },
});
