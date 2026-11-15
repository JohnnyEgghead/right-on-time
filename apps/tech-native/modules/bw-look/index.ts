// SPDX-License-Identifier: AGPL-3.0-or-later
// The BwLook native module's JavaScript face (ios/BwLookModule.swift). Absent in a build without it, the read answers nothing, so the
// comparator reports every tagged element as not found rather than passing.
import { requireOptionalNativeModule } from 'expo';

export type LookColor = [number, number, number, number];
export interface LookFace {
  size: number;
  postScript: string;
  uiFamily: string;
  family?: string;
  weight?: number;
}
export interface NativeLook {
  class: string;
  width: number;
  height: number;
  background?: LookColor;
  borderWidth?: number;
  borderColor?: LookColor;
  font?: LookFace;
  color?: LookColor;
  minLineHeight?: number;
  maxLineHeight?: number;
  text?: string;
  tint?: LookColor;
  svgClass?: string;
}

const mod = requireOptionalNativeModule<{ read(ids: string[]): Promise<Record<string, NativeLook>> }>('BwLook');

export async function readLook(ids: string[]): Promise<Record<string, NativeLook>> {
  return mod ? mod.read(ids) : {};
}
