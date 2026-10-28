// The code scanner's host and screen: the first code read ends the scan with that code, back ends
// it with null, a declined camera says so, and a build without a camera offers no scan at all.
import { act } from 'react';
import { View } from 'react-native';
import { afterEach, describe, expect, test } from 'vitest';

import { fire, render, type RenderResult } from '../../../../packages/ui/test/render.js';

import { useScanHost, type ScanHost, type ScanPlatform } from './ScanHost.js';
import { ScanScreen } from './ScanScreen.js';

let mounted: RenderResult | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

/** A camera that reads whatever the test hands `read`. */
function fakeCamera(granted = true) {
  let read: ((code: string) => void) | null = null;
  const platform: ScanPlatform = {
    ensurePermission: () => Promise.resolve(granted),
    renderScanner: (onCode) => {
      read = onCode;
      return <View testID="fake-scanner" />;
    },
  };
  return { platform, read: (code: string) => act(() => read?.(code)) };
}

function mount(platform: ScanPlatform | null): { readonly host: () => ScanHost } {
  let latest: ScanHost | null = null;
  function Probe(): React.JSX.Element | null {
    const host = useScanHost(platform);
    latest = host;
    return host.surface === null ? null : (
      <ScanScreen
        state={host.surface.state}
        preview={host.surface.preview}
        syncChip={null}
        avatar={null}
        onBack={host.surface.onBack}
      />
    );
  }
  mounted = render(<Probe />);
  return { host: () => latest! };
}

/** Let the permission answer land. */
const settle = () => act(() => Promise.resolve());

describe('the code scanner', () => {
  test('resolves the first code read and closes', async () => {
    const camera = fakeCamera();
    const { host } = mount(camera.platform);
    let result: string | null | undefined;
    await act(async () => {
      void host().scanCode!().then((code) => (result = code));
    });
    await settle();
    expect(mounted!.query('scan-viewfinder')).not.toBeNull();
    camera.read(' 8991234567890 ');
    camera.read('another frame');
    await settle();
    expect(result).toBe('8991234567890');
    expect(mounted!.query('scan-screen')).toBeNull();
  });

  test('back ends it with nothing read', async () => {
    const camera = fakeCamera();
    const { host } = mount(camera.platform);
    let result: string | null | undefined;
    await act(async () => {
      void host().scanCode!().then((code) => (result = code));
    });
    await settle();
    fire(mounted!.get('scan-screen.back'), 'onPress');
    await settle();
    expect(result).toBeNull();
    expect(mounted!.query('scan-screen')).toBeNull();
  });

  test('a declined camera says so instead of a dead viewfinder', async () => {
    const camera = fakeCamera(false);
    const { host } = mount(camera.platform);
    await act(async () => {
      void host().scanCode!();
    });
    await settle();
    expect(mounted!.query('scan-unauthorized')).not.toBeNull();
    expect(mounted!.query('scan-viewfinder')).toBeNull();
  });

  test('without a camera the screens get no scan to offer', () => {
    const { host } = mount(null);
    expect(host().scanCode).toBeUndefined();
  });
});
