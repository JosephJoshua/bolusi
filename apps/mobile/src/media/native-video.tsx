// The `expo-camera` recorder and `expo-video` player behind `VideoHost`. The one file that imports
// `expo-video`; like `native-capture.tsx` it keeps the native views out of everything testable.
//
// The clip is 720p at about 2 Mbit/s: a minute is some 15 MB, small enough to upload in the
// background like the photos and well under the server's cap. iOS takes the bitrate only with an
// explicit codec, so H.264 is named there; Android records H.264 in MP4 by default.
import { Camera, CameraView } from 'expo-camera';
import { File } from 'expo-file-system';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useRef } from 'react';
import { Platform, StyleSheet } from 'react-native';

import type { VideoPlatform, VideoRecorderPort } from './VideoHost.js';

const VIDEO_BITRATE = 2_000_000;
const CODEC = Platform.OS === 'ios' ? ({ codec: 'avc1' } as const) : {};

function Recorder({
  publish,
}: {
  readonly publish: (recorder: VideoRecorderPort | null) => void;
}): React.JSX.Element {
  const view = useRef<CameraView | null>(null);
  useEffect(() => () => publish(null), [publish]);
  return (
    <CameraView
      ref={(instance) => {
        view.current = instance;
      }}
      style={styles.fill}
      mode="video"
      // The counter films the customer holding their phone, so the back camera.
      facing="back"
      videoQuality="720p"
      videoBitrate={VIDEO_BITRATE}
      onCameraReady={() => {
        const instance = view.current;
        if (instance === null) return;
        publish({
          async record(maxMs) {
            const clip = await instance.recordAsync({
              maxDuration: Math.round(maxMs / 1000),
              ...CODEC,
            });
            if (clip === undefined) throw new Error('recordAsync returned no video');
            return { uri: clip.uri, mime: 'video/mp4' };
          },
          stop: () => instance.stopRecording(),
        });
      }}
      onMountError={() => publish(null)}
    />
  );
}

function Player({ uri }: { readonly uri: string }): React.JSX.Element {
  const player = useVideoPlayer(uri, (created) => {
    created.play();
  });
  return <VideoView player={player} style={styles.fill} contentFit="contain" nativeControls />;
}

export function createExpoVideoPlatform(): VideoPlatform {
  return {
    async ensurePermission(): Promise<boolean> {
      const camera = await Camera.requestCameraPermissionsAsync();
      if (!camera.granted) return false;
      return (await Camera.requestMicrophonePermissionsAsync()).granted;
    },
    renderPreview: (publish) => <Recorder publish={publish} />,
    renderPlayer: (uri) => <Player uri={uri} />,
    discard(uri) {
      try {
        const file = new File(uri);
        if (file.exists) file.delete();
      } catch {
        // The cache is cleared by the OS in time; nothing to tell the counter.
      }
    },
  };
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
