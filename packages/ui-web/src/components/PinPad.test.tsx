// The pad listens to the whole window. A new pad (the next PIN step) takes keys from the moment it
// shows, so digits typed straight after it appears are never lost to the one it replaced.
import { fireEvent, render, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { describe, expect, test } from 'vitest';

import { PinPad } from './PinPad.js';

function Steps({ onPin }: { readonly onPin: (pin: string) => void }): React.JSX.Element {
  const [step, setStep] = useState(1);
  useEffect(() => {
    // The next step arrives from an answer, not from a key: outside any event handler.
    void Promise.resolve().then(() => setStep(2));
  }, []);
  return (
    <>
      <p data-testid="step">{step}</p>
      <PinPad
        key={step}
        state="entry"
        onComplete={(pin) => onPin(`${String(step)}:${pin}`)}
        label="PIN"
        deleteLabel="Hapus"
      />
    </>
  );
}

describe('PinPad', () => {
  test('a pad takes keys as soon as it shows', async () => {
    const pins: string[] = [];
    const r = render(<Steps onPin={(pin) => pins.push(pin)} />);
    await waitFor(() => expect(r.getByTestId('step').textContent).toBe('2'));
    for (const key of '274816') fireEvent.keyDown(window, { key });
    expect(pins).toEqual(['2:274816']);
  });
});
