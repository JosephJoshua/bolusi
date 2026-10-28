// A repair's photos, kept to one row: a scrolling strip, a sheet with every photo by group, and the
// full-screen viewer (zoom, save or send). Used wherever a screen shows photos it does not capture.
import { t } from '@bolusi/i18n';
import { PhotoStrip, PhotoViewer, Sheet, TextButton, color, space, type } from '@bolusi/ui';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { ThumbnailRef } from '../../screen-kit/index.js';

import { tn } from '../i18n.js';
import { PhotoGrid, PhotoThumb, Section, repairStyles } from './parts.js';
import { useRepairRuntime } from '../runtime.js';

export interface BrowsablePhoto {
  readonly key: string;
  /** Which shot it is, e.g. "Depan", "Sebelum 1". */
  readonly label: string;
  /** The group it belongs to in the sheet, e.g. "Foto saat diterima". */
  readonly group: string;
  readonly ref: ThumbnailRef;
}

type Showing =
  | { readonly kind: 'none' }
  | { readonly kind: 'all' }
  | { readonly kind: 'one'; readonly index: number; readonly fromAll: boolean };

export interface PhotoBrowser {
  /** The "Foto" section with its strip, or null when there are no photos. */
  readonly section: ReactNode;
  /** Just the strip, for a screen that titles the section itself. */
  readonly strip: ReactNode;
  /** What to mount in the AppShell `overlay` slot. */
  readonly overlay: ReactNode;
  /** Hardware back: closes the viewer, then the sheet. False when neither is open. */
  readonly back: () => boolean;
}

export function usePhotoBrowser(
  photos: readonly BrowsablePhoto[],
  testID: string,
  title: string = tn('repair.photo.title'),
): PhotoBrowser {
  const runtime = useRepairRuntime();
  const [view, setView] = useState<Showing>({ kind: 'none' });
  const share = runtime.sharePhoto;

  const back = (): boolean => {
    if (view.kind === 'one') {
      setView(view.fromAll ? { kind: 'all' } : { kind: 'none' });
      return true;
    }
    if (view.kind === 'all') {
      setView({ kind: 'none' });
      return true;
    }
    return false;
  };

  const strip =
    photos.length === 0 ? null : (
      <PhotoStrip
        photos={photos.map((photo) => ({
          key: photo.key,
          label: photo.label,
          image: <PhotoThumb photo={photo.ref} testID={`${testID}.thumb.${photo.key}`} />,
        }))}
        onOpen={(index) => setView({ kind: 'one', index, fromAll: false })}
        openLabel={tn('repair.photo.open')}
        testID={`${testID}.strip`}
      />
    );

  const section =
    strip === null ? null : (
      <Section
        title={title}
        action={
          <TextButton
            label={tn('repair.photo.seeAll', { count: photos.length })}
            icon="photos"
            onPress={() => setView({ kind: 'all' })}
            testID={`${testID}.seeAll`}
          />
        }
        testID={testID}
      >
        {strip}
      </Section>
    );

  const groups = [...new Set(photos.map((photo) => photo.group))];
  const sheet =
    view.kind === 'none' ? null : (
      <Sheet
        title={tn('repair.photo.allTitle')}
        closeLabel={t('core.action.close')}
        onClose={() => setView({ kind: 'none' })}
        testID={`${testID}.sheet`}
      >
        {groups.map((group) => (
          <View key={group} style={styles.group}>
            <Text style={styles.groupTitle}>{group}</Text>
            <PhotoGrid>
              {photos.map((photo, index) =>
                photo.group !== group ? null : (
                  <Pressable
                    key={photo.key}
                    accessibilityRole="imagebutton"
                    accessibilityLabel={`${tn('repair.photo.open')} ${photo.label}`}
                    onPress={() => setView({ kind: 'one', index, fromAll: true })}
                    style={repairStyles.gridCell}
                    testID={`${testID}.sheet.${photo.key}`}
                  >
                    <PhotoThumb photo={photo.ref} testID={`${testID}.sheetThumb.${photo.key}`} />
                    <Text style={repairStyles.caption} numberOfLines={1}>
                      {photo.label}
                    </Text>
                  </Pressable>
                ),
              )}
            </PhotoGrid>
          </View>
        ))}
      </Sheet>
    );

  const viewer =
    view.kind !== 'one' ? null : (
      <PhotoViewer
        photos={photos.map(({ key, label }) => ({ key, label }))}
        initialIndex={view.index}
        renderImage={(index) => {
          const photo = photos[index];
          return photo === undefined ? null : (
            <PhotoThumb photo={photo.ref} full testID={`${testID}.full.${photo.key}`} />
          );
        }}
        onClose={back}
        onShare={
          share === undefined
            ? undefined
            : (index) => {
                const photo = photos[index];
                return photo === undefined ? Promise.resolve('failed') : share(photo.ref);
              }
        }
        labels={{
          close: t('core.action.close'),
          share: tn('repair.photo.share'),
          position: (index, total) => tn('repair.photo.position', { index, total }),
          shareFailed: tn('repair.photo.shareFailed'),
        }}
        testID={`${testID}.viewer`}
      />
    );

  return {
    section,
    strip,
    overlay:
      sheet === null && viewer === null ? null : (
        <>
          {/* The sheet stays under the viewer, so closing a photo opened from it lands back on it. */}
          {view.kind === 'one' && !view.fromAll ? null : sheet}
          {viewer}
        </>
      ),
    back,
  };
}

const styles = StyleSheet.create({
  group: { marginTop: space.md },
  groupTitle: { ...type.bodySm, fontWeight: '600', color: color.text, marginBottom: space.sm },
});
