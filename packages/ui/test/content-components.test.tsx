// Search, inline actions, the timeline and the photo strip/viewer: what a person can do with each.
import { act } from 'react';
import { describe, expect, test, vi } from 'vitest';

import { PhotoStrip } from '../src/components/PhotoStrip.js';
import { PhotoViewer, type PhotoShareResult } from '../src/components/PhotoViewer.js';
import { SearchField } from '../src/components/SearchField.js';
import { Sheet } from '../src/components/Sheet.js';
import { TextButton } from '../src/components/TextButton.js';
import { Timeline } from '../src/components/Timeline.js';
import { fire, render, textsIn } from './render.js';

describe('SearchField', () => {
  const field = (value: string, onChangeText = vi.fn()) =>
    render(
      <SearchField
        testID="s"
        value={value}
        onChangeText={onChangeText}
        placeholder="Cari nama"
        accessibilityLabel="Cari"
        clearLabel="Hapus pencarian"
      />,
    );

  test('has no visible label but announces what it is', () => {
    const r = field('');
    expect(r.get('s.field').props['accessibilityLabel']).toBe('Cari');
    expect(textsIn(r.container)).toEqual([]);
  });

  test('offers clearing only once something is typed, and clearing empties it', () => {
    expect(field('').query('s.clear')).toBeNull();
    const onChangeText = vi.fn();
    const r = field('maria', onChangeText);
    expect(r.get('s.clear').props['accessibilityLabel']).toBe('Hapus pencarian');
    fire(r.get('s.clear'), 'onPress');
    expect(onChangeText).toHaveBeenCalledWith('');
  });
});

describe('TextButton', () => {
  test('a disabled one is announced and does not fire', () => {
    const r = render(<TextButton testID="tb" label="Ganti" onPress={vi.fn()} disabled />);
    expect(r.get('tb').props['accessibilityState']).toEqual({ disabled: true });
    // Gated in the component, not left to Pressable (the double's fidelity rule).
    expect(r.get('tb').props['onPress']).toBeUndefined();
  });

  test('a short label can announce its full meaning', () => {
    const r = render(
      <TextButton testID="tb" label="Ganti" accessibilityLabel="Ganti teknisi" onPress={vi.fn()} />,
    );
    expect(r.get('tb').props['accessibilityLabel']).toBe('Ganti teknisi');
  });
});

describe('Timeline', () => {
  test('lists entries in the order given, with a note only where there is one', () => {
    const r = render(
      <Timeline
        testID="tl"
        entries={[
          { key: 'b', title: 'Dibatalkan', meta: '21/07 · Siti', detail: 'Pelanggan batal' },
          { key: 'a', title: 'Diterima', meta: '20/07 · Siti' },
        ]}
      />,
    );
    expect(textsIn(r.get('tl.entry.b'))).toEqual(['Dibatalkan', '21/07 · Siti', 'Pelanggan batal']);
    expect(textsIn(r.get('tl.entry.a'))).toEqual(['Diterima', '20/07 · Siti']);
  });
});

describe('PhotoStrip', () => {
  test('each tile names its shot and opens that photo', () => {
    const onOpen = vi.fn();
    const r = render(
      <PhotoStrip
        testID="ps"
        photos={[
          { key: 'front', label: 'Depan', image: null },
          { key: 'back', label: 'Belakang', image: null },
        ]}
        onOpen={onOpen}
        openLabel="Buka foto"
      />,
    );
    expect(r.get('ps.back').props['accessibilityLabel']).toBe('Buka foto Belakang');
    fire(r.get('ps.back'), 'onPress');
    expect(onOpen).toHaveBeenCalledWith(1);
  });
});

describe('Sheet', () => {
  test('closes from its button and from the scrim', () => {
    const onClose = vi.fn();
    const r = render(
      <Sheet testID="sh" title="Semua foto" closeLabel="Tutup" onClose={onClose}>
        {null}
      </Sheet>,
    );
    fire(r.get('sh.close'), 'onPress');
    fire(r.get('sh.scrim'), 'onPress');
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('PhotoViewer', () => {
  const LABELS = {
    close: 'Tutup',
    share: 'Simpan atau kirim',
    position: (index: number, total: number) => `${String(index)} dari ${String(total)}`,
    shareFailed: 'Belum bisa disimpan',
  };
  const PHOTOS = [
    { key: 'front', label: 'Depan' },
    { key: 'back', label: 'Belakang' },
  ];
  const viewer = (onShare?: (index: number) => Promise<PhotoShareResult>, onClose = vi.fn()) =>
    render(
      <PhotoViewer
        testID="pv"
        photos={PHOTOS}
        initialIndex={1}
        renderImage={() => null}
        onClose={onClose}
        onShare={onShare}
        labels={LABELS}
      />,
    );

  test('opens on the tapped photo and says where it is in the set', () => {
    const r = viewer();
    expect(textsIn(r.get('pv.label'))).toEqual(['Belakang']);
    expect(textsIn(r.get('pv.position'))).toEqual(['2 dari 2']);
  });

  test('shows no share button when the platform cannot share', () => {
    expect(viewer().query('pv.share')).toBeNull();
  });

  test('shares the photo on screen and closes from its button', () => {
    const onShare = vi.fn(() => Promise.resolve<PhotoShareResult>('done'));
    const onClose = vi.fn();
    const r = viewer(onShare, onClose);
    fire(r.get('pv.share'), 'onPress');
    expect(onShare).toHaveBeenCalledWith(1);
    fire(r.get('pv.close'), 'onPress');
    expect(onClose).toHaveBeenCalled();
  });

  test('says so when the photo could not be handed over', async () => {
    const r = viewer(() => Promise.reject(new Error('no sheet')));
    fire(r.get('pv.share'), 'onPress');
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(textsIn(r.get('pv.notice'))).toEqual(['Belum bisa disimpan']);
  });
});
