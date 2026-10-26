import { describe, expect, test } from 'vitest';

import {
  answerNotificationAsk,
  shouldAskForNotifications,
  type NotificationPermissionPort,
} from './permission.js';

function fakePort(over: {
  granted?: boolean;
  canAskAgain?: boolean;
  asked?: boolean;
  failRequest?: boolean;
}) {
  const calls: string[] = [];
  let asked = over.asked ?? false;
  const port: NotificationPermissionPort = {
    status: async () => ({ granted: over.granted ?? false, canAskAgain: over.canAskAgain ?? true }),
    request: async () => {
      calls.push('request');
      if (over.failRequest === true) throw new Error('no activity');
    },
    readAsked: async () => asked,
    writeAsked: async () => {
      calls.push('writeAsked');
      asked = true;
    },
  };
  return { port, calls };
}

describe('notification permission ask', () => {
  test('asks a device that never saw the sheet and can still prompt', async () => {
    expect(await shouldAskForNotifications(fakePort({}).port)).toBe(true);
  });

  test('never asks when already granted (Android 12 and older), refused for good, or asked before', async () => {
    expect(await shouldAskForNotifications(fakePort({ granted: true }).port)).toBe(false);
    expect(await shouldAskForNotifications(fakePort({ canAskAgain: false }).port)).toBe(false);
    expect(await shouldAskForNotifications(fakePort({ asked: true }).port)).toBe(false);
  });

  test('"Nanti saja" records the answer without the OS prompt, and the sheet does not come back', async () => {
    const { port, calls } = fakePort({});
    await answerNotificationAsk(port, false);
    expect(calls).toEqual(['writeAsked']);
    expect(await shouldAskForNotifications(port)).toBe(false);
  });

  test('"Nyalakan" records the answer before the OS prompt, so a failing prompt never nags', async () => {
    const { port, calls } = fakePort({ failRequest: true });
    await answerNotificationAsk(port, true);
    expect(calls).toEqual(['writeAsked', 'request']);
    expect(await shouldAskForNotifications(port)).toBe(false);
  });
});
