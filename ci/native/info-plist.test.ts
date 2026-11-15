// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: F-1225
// App Store Connect warned on build 2 (ITMS-90683): the binary links a location API and Info.plist has no location purpose string.
// The map module (@maplibre/maplibre-react-native) compiles ios/modules/location/MLRNLocationManager.m, which calls CLLocationManager's
// requestWhenInUseAuthorization, into every build, though the app's own code never asks for location. So while the module holds that
// call, app.json carries NSLocationWhenInUseUsageDescription (expo prebuild writes ios.infoPlist into ios/RightOnTime/Info.plist), and
// its words say what is true: the app does not ask, the map part can.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const app = path.resolve(import.meta.dirname, '../../apps/tech-native');
const locationModule = path.join(app, 'node_modules/@maplibre/maplibre-react-native/ios/modules/location/MLRNLocationManager.m');
const infoPlist = (): Record<string, unknown> => JSON.parse(readFileSync(path.join(app, 'app.json'), 'utf8')).expo.ios.infoPlist;

/** Every .ts and .tsx file under apps/tech-native/src (the app's own code). */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const f = path.join(dir, name);
    if (statSync(f).isDirectory()) return sources(f);
    return /\.tsx?$/.test(name) ? [f] : [];
  });
}

describe('the native app location purpose string (F-1225)', () => {
  it('names a location purpose while the map module can ask for location', () => {
    // why: F-1225 a build whose binary can ask for location without the purpose string carries ITMS-90683 into App Store review
    expect(readFileSync(locationModule, 'utf8')).toContain('requestWhenInUseAuthorization');
    const words = infoPlist().NSLocationWhenInUseUsageDescription;
    expect(typeof words).toBe('string');
    expect(words as string).toMatch(/^Right On Time .{20,}/);
  });

  it("keeps the app's own code free of a location ask, as the purpose string says", () => {
    // why: F-1225 the purpose string says the app does not ask for location; a screen that asks makes it untrue
    const asks = sources(path.join(app, 'src')).filter((f) =>
      /\b(UserLocation|NativeUserLocation|LocationManager|requestForegroundPermissionsAsync)\b|expo-location/.test(readFileSync(f, 'utf8')),
    );
    expect(asks.map((f) => path.relative(app, f))).toEqual([]);
  });
});
