// SPDX-License-Identifier: AGPL-3.0-or-later
// The phone's half of SD-32 (photo.ts): the system camera and photo picker (expo-image-picker: UIImagePickerController for the camera,
// PHPickerViewController for the library, so choosing a photo needs no library permission) and the platform JPEG encoder
// (expo-image-manipulator over UIKit's ImageIO). The picked file and the encoded JPEG are the picker's and the encoder's temporary
// files; the store keeps its own copy of the bytes (FileItemStore.put), so neither is needed after Save photo.
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import type { Encoder } from './photo.ts';

export const expoEncoder: Encoder = {
  async jpeg(uri, size, quality) {
    const ref = await ImageManipulator.manipulate(uri).resize(size).renderAsync();
    const r = await ref.saveAsync({ compress: quality, format: SaveFormat.JPEG });
    const bytes = await new File(r.uri).bytes();
    return { uri: r.uri, bytes, width: r.width, height: r.height };
  },
  original: (uri) => new File(uri).bytes(),
};

export type Picked = { kind: 'picked'; uri: string; width: number; height: number } | { kind: 'canceled' } | { kind: 'denied' } | { kind: 'failed' };

const OPTIONS: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], allowsEditing: false, quality: 1, exif: false };

/** CTL-TEC-06-01: the camera (asking for its permission first; refused: CTL-TEC-06-06) or the library picker. */
export async function pickPhoto(from: 'camera' | 'library'): Promise<Picked> {
  try {
    if (from === 'camera') {
      const p = await ImagePicker.requestCameraPermissionsAsync();
      if (!p.granted) return { kind: 'denied' };
    }
    const r = from === 'camera' ? await ImagePicker.launchCameraAsync(OPTIONS) : await ImagePicker.launchImageLibraryAsync(OPTIONS);
    const a = r.canceled ? null : r.assets[0];
    if (!a) return { kind: 'canceled' };
    return { kind: 'picked', uri: a.uri, width: a.width, height: a.height };
  } catch {
    // the simulator has no camera: the camera picker fails to open
    return { kind: 'failed' };
  }
}
