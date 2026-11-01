// The ownership video on the phone screens: at intake one tile that records or retakes it, and on
// the servisan the clip that was taken, to play back.
import { formatDateTime } from '@bolusi/i18n';
import { Icon, PhotoSlot, TextButton, TileGrid, color, size, space, Text } from '@bolusi/ui';
import { StyleSheet, View } from 'react-native';

import type { ActionRunner, VideoMediaRef } from '../../screen-kit/index.js';
import { tn } from '../i18n.js';
import { useTicketVideo } from '../ownership-video.js';
import type { TicketDetailRow } from '../queries.js';
import { Section, repairStyles } from './parts.js';

/** Empty, a tap records it; once recorded, a tap plays it and "Rekam ulang" takes another. */
export function OwnershipVideoTile({
  video,
  onRecord,
  onPlay,
  testID,
}: {
  readonly video: VideoMediaRef | null;
  /** Absent ⇒ this person or device cannot record one here. */
  readonly onRecord?: (() => void) | undefined;
  readonly onPlay?: ((video: VideoMediaRef) => void) | undefined;
  readonly testID: string;
}): React.JSX.Element {
  const play = video === null || onPlay === undefined ? undefined : () => onPlay(video);
  return (
    <View style={styles.row} testID={testID}>
      <TileGrid>
        <PhotoSlot
          label={tn('repair.video.label')}
          emptyIcon="video"
          actionLabel={tn(video === null ? 'repair.video.record' : 'repair.video.play')}
          image={
            video === null ? null : (
              <View style={styles.recorded}>
                <Icon name="play" size={size.iconState} color={color.textMuted} />
              </View>
            )
          }
          onPress={video === null ? onRecord : play}
          testID={`${testID}.slot`}
        />
      </TileGrid>
      {video !== null && onRecord !== undefined ? (
        <View style={styles.retake}>
          <TextButton
            label={tn('repair.video.retake')}
            icon="video"
            onPress={onRecord}
            testID={`${testID}.retake`}
          />
        </View>
      ) : null}
    </View>
  );
}

/** The servisan's ownership video, when the intake took one. */
export function TicketVideoSection({
  ticket,
  runner,
  testID,
}: {
  readonly ticket: TicketDetailRow;
  readonly runner: ActionRunner;
  readonly testID: string;
}): React.JSX.Element | null {
  const clip = useTicketVideo({ ticket, runner });
  if (clip.latest === null) return null;
  return (
    <Section title={tn('repair.video.title')} testID={testID}>
      <View style={styles.column}>
        <Text style={repairStyles.muted} testID={`${testID}.recordedAt`}>
          {tn('repair.video.recordedAt', { at: formatDateTime(clip.latest.capturedAt) })}
        </Text>
        <OwnershipVideoTile video={clip.video} onPlay={clip.play} testID={`${testID}.tile`} />
      </View>
    </Section>
  );
}

const styles = StyleSheet.create({
  row: { gap: space.xs },
  retake: { alignSelf: 'flex-start' },
  column: { gap: space.sm },
  recorded: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.surfaceAlt,
  },
});
