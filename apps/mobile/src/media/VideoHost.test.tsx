// The video recorder and player: a clip is recorded, kept encrypted and handed back only once the
// counter keeps it; back ends it with nothing; a stored clip plays and closes; a declined camera
// or microphone says so; and the timer counts up to the minute allowed.
import { act, useEffect } from 'react';
import { View } from 'react-native';
import { afterEach, describe, expect, test } from 'vitest';

import type { CapturedVideo, VideoMediaRef } from '@bolusi/modules/screen-kit';
import type { MediaClient } from '@bolusi/device/media/client';
import type { RecordedVideo } from '@bolusi/device/media/import';
import type { VideoRef } from '@bolusi/schemas';

import { fire, render, type RenderResult } from '../../../../packages/ui/test/render.js';

import {
  useVideoHost,
  type VideoHost,
  type VideoPlatform,
  type VideoRecorderPort,
} from './VideoHost.js';
import { VideoScreen, clipTime } from './VideoScreen.js';

let mounted: RenderResult | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

const IDENTITY = { tenantId: 'tn-1', storeId: 's-1', userId: 'u-1', deviceId: 'd-1' };
const CLIP: VideoRef = {
  mediaId: 'v-1',
  sha256: 'a'.repeat(64),
  mime: 'video/mp4',
  type: 'video',
  sizeBytes: 9_000_000,
  capturedAt: 1,
  location: null,
  userId: 'u-1',
  deviceId: 'd-1',
};

/** A camera that records until the test stops it, and a player that shows the uri it plays. */
function fakeCamera(granted = true) {
  let finish: ((clip: RecordedVideo) => void) | null = null;
  const asked: number[] = [];
  const discarded: string[] = [];
  const recorder: VideoRecorderPort = {
    record: (maxMs) => {
      asked.push(maxMs);
      return new Promise((resolve) => (finish = resolve));
    },
    stop: () => finish?.({ uri: 'file:///clip.mp4', mime: 'video/mp4' }),
  };
  const platform: VideoPlatform = {
    ensurePermission: () => Promise.resolve(granted),
    renderPreview: (publish) => <Preview publish={publish} recorder={recorder} />,
    renderPlayer: (uri) => <View testID={`fake-player:${uri}`} />,
    discard: (uri) => discarded.push(uri),
  };
  return { platform, asked, discarded };
}

function Preview({
  publish,
  recorder,
}: {
  readonly publish: (recorder: VideoRecorderPort | null) => void;
  readonly recorder: VideoRecorderPort;
}): React.JSX.Element {
  // The camera is ready as soon as it mounts.
  useEffect(() => publish(recorder), [publish, recorder]);
  return <View testID="fake-viewfinder" />;
}

function fakeMedia(
  render: 'local' | 'unavailable' = 'local',
  importAs: 'imported' | 'refused_too_large' = 'imported',
) {
  const imported: RecordedVideo[] = [];
  const media = {
    storageBand: () => 'normal',
    importVideo: (_identity: unknown, recorded: RecordedVideo) => {
      imported.push(recorded);
      return Promise.resolve(
        importAs === 'imported'
          ? { kind: 'imported', ref: CLIP }
          : { kind: 'refused_too_large', sizeBytes: 60_000_000 },
      );
    },
    loadForRender: (ref: { mediaId: string }) =>
      Promise.resolve(
        render === 'local'
          ? { kind: 'local', uri: `file:///plain/${ref.mediaId}.mp4` }
          : { kind: 'unavailable' },
      ),
  } as unknown as MediaClient;
  return { media, imported };
}

function mount(platform: VideoPlatform | null, media: MediaClient | null) {
  let latest: VideoHost | null = null;
  function Probe(): React.JSX.Element | null {
    const host = useVideoHost({ media, platform, identity: IDENTITY });
    latest = host;
    const surface = host.surface;
    return surface === null ? null : (
      <VideoScreen
        title={surface.title}
        hint={surface.hint}
        state={surface.state}
        view={surface.view}
        maxMs={surface.maxMs}
        syncChip={null}
        avatar={null}
        onStart={surface.onStart}
        onStop={surface.onStop}
        onRetake={surface.onRetake}
        onUse={surface.onUse}
        onRetry={surface.onRetry}
        onBack={surface.onBack}
        now={() => 7_000}
      />
    );
  }
  mounted = render(<Probe />);
  return { host: () => latest! };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await act(() => Promise.resolve());
};

const REQUEST = { title: 'Video kepemilikan', hint: 'Bilang HP ini milikmu.', maxMs: 60_000 };

describe('recording the ownership video', () => {
  test('records for at most the minute asked, then hands back the kept clip', async () => {
    const camera = fakeCamera();
    const { media, imported } = fakeMedia();
    const { host } = mount(camera.platform, media);
    let result: CapturedVideo | null | undefined;
    await act(async () => {
      void host()
        .recordVideo(REQUEST)
        .then((video) => (result = video));
    });
    await settle();
    expect(mounted!.query('video-hint')).not.toBeNull();
    fire(mounted!.get('video-start'), 'onPress');
    await settle();
    expect(camera.asked).toEqual([60_000]);
    expect(mounted!.query('video-timer')).not.toBeNull();

    fire(mounted!.get('video-stop'), 'onPress');
    await settle();
    expect(imported).toEqual([{ uri: 'file:///clip.mp4', mime: 'video/mp4' }]);
    // The counter watches it back before keeping it.
    expect(mounted!.query('fake-player:file:///plain/v-1.mp4')).not.toBeNull();
    expect(result).toBeUndefined();

    fire(mounted!.get('video-use'), 'onPress');
    await settle();
    expect(result).toEqual({ videoRef: CLIP });
    expect(mounted!.query('video-screen')).toBeNull();
  });

  test('back ends it with nothing, and a second request while one is open is refused', async () => {
    const camera = fakeCamera();
    const { media } = fakeMedia();
    const { host } = mount(camera.platform, media);
    let result: CapturedVideo | null | undefined;
    await act(async () => {
      void host()
        .recordVideo(REQUEST)
        .then((video) => (result = video));
    });
    await settle();
    await expect(host().recordVideo(REQUEST)).rejects.toThrow('busy');
    fire(mounted!.get('video-screen.back'), 'onPress');
    await settle();
    expect(result).toBeNull();
  });

  test('a clip that finishes after the counter backed out is deleted, not kept', async () => {
    const camera = fakeCamera();
    const { media, imported } = fakeMedia();
    const { host } = mount(camera.platform, media);
    await act(async () => {
      void host().recordVideo(REQUEST);
    });
    await settle();
    fire(mounted!.get('video-start'), 'onPress');
    await settle();
    fire(mounted!.get('video-screen.back'), 'onPress');
    await settle();
    expect(imported).toEqual([]);
    expect(camera.discarded).toEqual(['file:///clip.mp4']);
  });

  test('a clip too big to send asks for a shorter one', async () => {
    const camera = fakeCamera();
    const { media } = fakeMedia('local', 'refused_too_large');
    const { host } = mount(camera.platform, media);
    await act(async () => {
      void host().recordVideo(REQUEST);
    });
    await settle();
    fire(mounted!.get('video-start'), 'onPress');
    await settle();
    fire(mounted!.get('video-stop'), 'onPress');
    await settle();
    expect(mounted!.query('video-too-large')).not.toBeNull();
  });

  test('a declined camera or microphone says so', async () => {
    const camera = fakeCamera(false);
    const { media } = fakeMedia();
    const { host } = mount(camera.platform, media);
    await act(async () => {
      void host().recordVideo(REQUEST);
    });
    await settle();
    expect(mounted!.query('video-unauthorized')).not.toBeNull();
  });

  test('a device without a camera offers none', async () => {
    const { media } = fakeMedia();
    const { host } = mount(null, media);
    await expect(host().recordVideo(REQUEST)).rejects.toThrow('not available');
  });
});

describe('playing a stored clip', () => {
  const ref: VideoMediaRef = { mediaId: 'v-9', sha256: 'b'.repeat(64), mime: 'video/mp4' };

  test('plays it and resolves once closed', async () => {
    const camera = fakeCamera();
    const { media } = fakeMedia();
    const { host } = mount(camera.platform, media);
    let closed = false;
    await act(async () => {
      void host()
        .playVideo(ref, { title: 'Video kepemilikan' })
        .then(() => (closed = true));
    });
    await settle();
    expect(mounted!.query('fake-player:file:///plain/v-9.mp4')).not.toBeNull();
    fire(mounted!.get('video-done'), 'onPress');
    await settle();
    expect(closed).toBe(true);
    expect(mounted!.query('video-screen')).toBeNull();
  });

  test('one not on this phone yet says so', async () => {
    const camera = fakeCamera();
    const { media } = fakeMedia('unavailable');
    const { host } = mount(camera.platform, media);
    await act(async () => {
      void host().playVideo(ref, { title: 'Video kepemilikan' });
    });
    await settle();
    expect(mounted!.query('video-unavailable')).not.toBeNull();
  });
});

test('the timer reads like a phone recorder', () => {
  expect(clipTime(0)).toBe('0:00');
  expect(clipTime(7_400)).toBe('0:07');
  expect(clipTime(60_000)).toBe('1:00');
});
