/** The system share sheet (expo-sharing), bound for `createPhotoSharer`. Native only. */
import * as Sharing from 'expo-sharing';

import type { SharePlatform } from './share.js';

export const expoSharePlatform: SharePlatform = {
  isAvailable: () => Sharing.isAvailableAsync(),
  share: (uri, mimeType) => Sharing.shareAsync(uri, { mimeType }),
};
