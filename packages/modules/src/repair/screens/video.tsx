// The ownership video on the phone screens: one tile that records or retakes it, and a play button
// once there is one. Used at intake, on the servisan and at handover.
import { formatDateTime } from '@bolusi/i18n';
import { Icon, PhotoSlot, TextButton, color, size, space } from '@bolusi/ui';
import { StyleSheet, Text, View } from 'react-native';

import type { ActionRunner, VideoMediaRef } from '../../screen-kit/index.js';
import { tn } from '../i18n.js';
import { useTicketVideo } from '../ownership-video.js';
import type { TicketDetailRow } from '../queries.js';
import { PhotoGrid, Section, repairStyles, usePhotoGridCell } from './parts.js';

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
  const cell = usePhotoGridCell();
  const play = video === null || onPlay === undefined ? undefined : () => onPlay(video);
  return (
    <View style={styles.row} testID={testID}>
      <PhotoGrid>
        <View style={cell}>
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
        </View>
      </PhotoGrid>
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

/** The servisan's ownership video: shown once one is taken or a repair type asks for it. */
export function TicketVideoSection({
  ticket,
  canRecord,
  runner,
  onRecorded,
  atHandover = false,
  testID,
}: {
  readonly ticket: TicketDetailRow;
  /** The handover's own hint already says it is needed: say what to film instead. */
  readonly atHandover?: boolean;
  /** Intake permission and a servisan still open. */
  readonly canRecord: boolean;
  readonly runner: ActionRunner;
  readonly onRecorded: () => void;
  readonly testID: string;
}): React.JSX.Element | null {
  const clip = useTicketVideo({ ticket, canRecord, runner, onRecorded });
  if (!clip.shown) return null;
  return (
    <Section title={tn('repair.video.title')} testID={testID}>
      <View style={styles.column}>
        {clip.latest === null ? (
          atHandover ? (
            <Text style={repairStyles.muted} testID={`${testID}.hint`}>
              {tn('repair.video.hint')}
            </Text>
          ) : (
            <Text style={repairStyles.warning} testID={`${testID}.needed`}>
              {tn('repair.video.needed')}
            </Text>
          )
        ) : (
          <Text style={repairStyles.muted} testID={`${testID}.recordedAt`}>
            {tn('repair.video.recordedAt', { at: formatDateTime(clip.latest.capturedAt) })}
          </Text>
        )}
        {clip.noCamera && clip.latest === null ? (
          <Text style={repairStyles.muted} testID={`${testID}.noCamera`}>
            {tn('repair.video.noCamera')}
          </Text>
        ) : null}
        <OwnershipVideoTile
          video={clip.video}
          onRecord={clip.record}
          onPlay={clip.play}
          testID={`${testID}.tile`}
        />
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
