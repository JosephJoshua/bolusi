import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { PageHeader } from './Shell.js';
import { TooltipProvider } from './Tooltip.js';

function header(onBack: () => void, crumb = vi.fn()) {
  return render(
    <TooltipProvider>
      <PageHeader
        title="Terima HP"
        trail={[{ key: 'repair', label: 'Servisan', onSelect: crumb }]}
        trailLabel="Lokasi halaman"
        onBack={onBack}
        backLabel="Kembali"
      />
    </TooltipProvider>,
  );
}

afterEach(cleanup);

describe('PageHeader', () => {
  test('names the way to the page, each level a link back to it', () => {
    const crumb = vi.fn();
    const r = header(vi.fn(), crumb);
    expect(r.getByRole('navigation', { name: 'Lokasi halaman' }).textContent).toBe('Servisan');
    expect(r.getByRole('heading', { level: 1 }).textContent).toBe('Terima HP');
    fireEvent.click(r.getByTestId('page.crumb.repair'));
    expect(crumb).toHaveBeenCalledTimes(1);
  });

  test('a level that is no page of its own is named, not linked', () => {
    const r = render(
      <PageHeader title="Stok" trail={[{ key: 'items', label: 'Barang' }]} trailLabel="Lokasi" />,
    );
    expect(r.getByTestId('page.crumb.items').tagName).toBe('SPAN');
  });

  test('the back arrow, Alt+Left and the mouse back button all go back', () => {
    const onBack = vi.fn();
    const r = header(onBack);
    fireEvent.click(r.getByTestId('page.back'));
    fireEvent.keyDown(window, { key: 'ArrowLeft', altKey: true });
    fireEvent.mouseDown(window, { button: 3 });
    fireEvent.mouseUp(window, { button: 3 });
    expect(onBack).toHaveBeenCalledTimes(3);
    // A plain arrow key moves the caret, and other mouse buttons do nothing.
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    fireEvent.mouseUp(window, { button: 0 });
    expect(onBack).toHaveBeenCalledTimes(3);
  });

  test('a dialog over the page keeps back to itself', () => {
    const onBack = vi.fn();
    header(onBack);
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.append(dialog);
    try {
      fireEvent.keyDown(window, { key: 'ArrowLeft', altKey: true });
      fireEvent.mouseUp(window, { button: 3 });
      expect(onBack).not.toHaveBeenCalled();
    } finally {
      dialog.remove();
    }
  });
});
