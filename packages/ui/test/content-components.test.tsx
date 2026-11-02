// Search, inline actions, the timeline and the photo strip/viewer: what a person can do with each.
import { act } from 'react';
import { Keyboard, StyleSheet } from 'react-native';
import { describe, expect, test, vi } from 'vitest';

import { ConfirmSheet } from '../src/components/ConfirmSheet.js';
import { PhotoStrip } from '../src/components/PhotoStrip.js';
import { PhotoViewer, type PhotoShareResult } from '../src/components/PhotoViewer.js';
import { SearchField } from '../src/components/SearchField.js';
import { Sheet } from '../src/components/Sheet.js';
import { TextButton } from '../src/components/TextButton.js';
import { Timeline } from '../src/components/Timeline.js';
import { size } from '../src/tokens.js';
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
    // The only text is the hint of what it searches, and a screen reader hears it once.
    expect(textsIn(r.container)).toEqual(['Cari nama']);
    expect(r.get('s.placeholder').props['importantForAccessibility']).toBe('no-hide-descendants');
    expect(r.get('s.field').props['accessibilityHint']).toBe('Cari nama');
  });

  // Regression: at the largest font the input's own placeholder was cut to "Cari nama, no. HP,
  // no. ser". Ours is text that wraps, so the whole hint shows; it goes once something is typed.
  test('the hint wraps instead of being cut, and goes once something is typed', () => {
    const r = field('');
    expect(r.get('s.field').props['placeholder']).toBeUndefined();
    expect(r.get('s.placeholder').props['numberOfLines']).toBeUndefined();
    expect(field('maria').query('s.placeholder')).toBeNull();
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

  test('a caption is never cut: it wraps, and the tile widens for it (large font, tablet column)', () => {
    const r = render(
      <PhotoStrip
        testID="ps"
        photos={[{ key: 'back', label: 'Belakang kiri bawah', image: null }]}
        onOpen={vi.fn()}
        openLabel="Buka foto"
      />,
    );
    const caption = r
      .get('ps.back')
      .queryAll((node) => node.props['children'] === 'Belakang kiri bawah')[0]!;
    expect(caption.props['numberOfLines']).toBeUndefined();
    const tile = StyleSheet.flatten(r.get('ps.back').props['style']) as Record<string, unknown>;
    expect(tile['width']).toBeUndefined();
    expect(tile['minWidth']).toBe(size.photoStrip);
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

// A sheet opened while a field is focused sat under the keyboard, its buttons out of sight (first
// Android QA run). Each overlay closes the keyboard as it opens.
describe('overlays never open under the keyboard', () => {
  const dismissals = (): number => (Keyboard as unknown as { dismissCount: number }).dismissCount;

  test('ConfirmSheet', () => {
    const before = dismissals();
    render(
      <ConfirmSheet
        title="Buang?"
        confirmLabel="Buang"
        onConfirm={vi.fn()}
        cancelLabel="Lanjut isi"
        onCancel={vi.fn()}
      />,
    );
    expect(dismissals()).toBe(before + 1);
  });

  test('Sheet', () => {
    const before = dismissals();
    render(
      <Sheet title="Semua foto" closeLabel="Tutup" onClose={vi.fn()}>
        {null}
      </Sheet>,
    );
    expect(dismissals()).toBe(before + 1);
  });

  test('PhotoViewer', () => {
    const before = dismissals();
    render(
      <PhotoViewer
        photos={[{ key: 'front', label: 'Depan' }]}
        initialIndex={0}
        renderImage={() => null}
        labels={{
          close: 'Tutup',
          share: 'Kirim',
          position: () => '1 dari 1',
          shareFailed: 'Gagal',
        }}
        onClose={vi.fn()}
      />,
    );
    expect(dismissals()).toBe(before + 1);
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
