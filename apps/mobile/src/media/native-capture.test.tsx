// The native camera binding, with expo-camera replaced by a counting stand-in. What matters here is
// how often the native view is handed props: on Android every update can rebuild the camera.
import { useState } from 'react';
import { act } from 'react';
import { describe, expect, test, vi } from 'vitest';

import { render } from '../../../../packages/ui/test/render.js';

const cameraRenders = vi.hoisted(() => ({ count: 0 }));

vi.mock('expo-camera', () => ({
  Camera: { requestCameraPermissionsAsync: vi.fn() },
  CameraView: function CameraView(): null {
    cameraRenders.count += 1;
    return null;
  },
}));
vi.mock('expo-image', () => ({ Image: () => null }));

const { createExpoCapturePlatform } = await import('./native-capture.js');

describe('the viewfinder', () => {
  test('a render of the screen around it never re-renders the native camera view', () => {
    // The shutter press re-renders the capture screen. When that reached CameraView on Android,
    // expo-camera rebuilt the camera mid-capture and the photo came out black.
    const platform = createExpoCapturePlatform();
    const publish = vi.fn();
    let bump: () => void = () => undefined;
    function Screen(): React.JSX.Element {
      const [, setTick] = useState(0);
      bump = () => setTick((tick) => tick + 1);
      return <>{platform.renderPreview(publish)}</>;
    }
    render(<Screen />);
    expect(cameraRenders.count).toBe(1);
    act(() => bump());
    act(() => bump());
    expect(cameraRenders.count).toBe(1);
  });
});
