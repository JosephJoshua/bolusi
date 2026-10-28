// The gallery binding for `GalleryPort` (the store logo): the system photo picker, then one resize
// into the cache. Native only, and not device-verified here, like the rest of this folder's native
// files. Neither platform asks for photo permission: Android 13+ and iOS 14+ use the system picker.
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import type { GalleryPort } from '@bolusi/device/media/import';

/** A logo prints a few centimetres wide; this keeps it sharp at 300 dpi without carrying a photo. */
const LOGO_MAX_EDGE = 800;

export const expoGallery: GalleryPort = {
  async pick() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: false,
      quality: 1,
    });
    const asset = result.canceled ? undefined : result.assets[0];
    if (asset === undefined) return null;
    // A PNG stays a PNG so a logo on a transparent background does not turn black as a JPEG.
    const png = asset.mimeType === 'image/png';
    const context = ImageManipulator.manipulate(asset.uri);
    if (Math.max(asset.width, asset.height) > LOGO_MAX_EDGE) {
      context.resize(
        asset.width >= asset.height ? { width: LOGO_MAX_EDGE } : { height: LOGO_MAX_EDGE },
      );
    }
    const image = await context.renderAsync();
    const saved = await image.saveAsync(
      png ? { format: SaveFormat.PNG } : { format: SaveFormat.JPEG, compress: 0.85 },
    );
    return { uri: saved.uri, mime: png ? 'image/png' : 'image/jpeg' };
  },
};
