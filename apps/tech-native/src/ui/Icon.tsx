// SPDX-License-Identifier: AGPL-3.0-or-later
// A DK-70 line icon (icon-paths.ts), drawn as the kit draws it: a 24-unit box, round caps and joins, no fill, stroked in its color.
import { SvgXml } from 'react-native-svg';
import { lk } from './look.ts';
import { ALL_ICON_PATHS, type NativeIcon } from './icon-paths.ts';

export function Icon(props: { name: NativeIcon; size: number; color: string; strokeWidth?: number; id?: string; marginTop?: number }) {
  const xml = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${props.strokeWidth ?? 1.9}" stroke-linecap="round" stroke-linejoin="round">${ALL_ICON_PATHS[props.name]}</svg>`;
  const box = { width: props.size, height: props.size, ...(props.marginTop ? { marginTop: props.marginTop } : {}) };
  // The tag sits on the SVG view itself (RNSVGSvgView), so the look reader finds the view that holds the drawn color.
  const tag = props.id ? lk(props.id, box) : { style: box };
  return <SvgXml {...tag} xml={xml} width={props.size} height={props.size} color={props.color} accessible={false} />;
}
