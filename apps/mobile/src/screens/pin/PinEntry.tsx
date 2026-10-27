/**
 * The body every PIN screen shares (sign in, first PIN, change PIN, an owner's reset): who the PIN
 * is for, the one question being asked ("Masukkan PIN", "Ulangi PIN baru"), the pad with its message
 * slot, and an optional quiet link under it ("Lupa PIN?").
 *
 * The question is its own line above the dots and the pad's message slot carries only feedback
 * (wrong PIN, attempts left), so the prompt never turns red and the feedback never replaces it.
 *
 * On a tablet held sideways the person stands on the left and the pad on the right: stacked, the
 * pad would run below a short landscape screen and need scrolling to reach 0.
 */
import { Avatar, PinPad, color, space, type, useViewport, type PinPadState } from '@bolusi/ui';
import type { ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { initialsOf } from '../switcher/model.js';
import { roleLabel } from '../switcher/UserRow.js';

export interface PinEntryPerson {
  readonly id: string;
  readonly name: string;
  readonly roleKeys?: readonly string[] | undefined;
}

export interface PinEntryProps {
  /** Whose PIN this is, shown big so nobody types into a colleague's account. */
  readonly person?: PinEntryPerson | undefined;
  /** Already-localized: the one thing asked of the person right now. */
  readonly prompt: string;
  /** Already-localized feedback under the dots, or nothing. */
  readonly message?: string | undefined;
  readonly state: PinPadState;
  readonly onComplete: (pin: string) => void;
  /** Changing it remounts the pad, clearing its digits between steps. */
  readonly padKey?: string | undefined;
  readonly backspaceLabel: string;
  readonly footer?: ReactNode;
  /**
   * Already-localized: the PIN is being saved. Hashing a PIN takes a few seconds on a slow phone, so
   * the pad gives way to a spinner and this line instead of sitting there full and frozen.
   */
  readonly busyLabel?: string | undefined;
  readonly testID: string;
}

export function PinEntry({
  person,
  prompt,
  message,
  state,
  onComplete,
  padKey,
  backspaceLabel,
  footer,
  busyLabel,
  testID,
}: PinEntryProps): React.JSX.Element {
  const viewport = useViewport();
  // Sideways on a tablet: who, the question and the quiet link on the left, the pad alone on the
  // right, so the whole pad fits a short landscape screen without scrolling.
  const sideBySide =
    person !== undefined && viewport.widthClass !== 'compact' && viewport.width > viewport.height;
  const who =
    person === undefined ? null : <PinPerson person={person} testID={`${testID}-person`} />;
  if (busyLabel !== undefined) {
    return (
      <View style={[styles.root, sideBySide ? styles.rootSide : null]} testID={testID}>
        {sideBySide ? <View style={styles.side}>{who}</View> : who}
        <View style={[styles.busy, sideBySide ? styles.side : null]} testID={`${testID}-busy`}>
          <ActivityIndicator color={color.primary} />
          <Text style={styles.prompt} accessibilityLiveRegion="polite">
            {busyLabel}
          </Text>
        </View>
      </View>
    );
  }
  const question = (
    <Text
      style={person === undefined ? styles.promptAlone : styles.prompt}
      accessibilityRole="header"
      testID={`${testID}-prompt`}
    >
      {prompt}
    </Text>
  );
  const pad = (
    <PinPad
      key={padKey}
      onComplete={onComplete}
      state={state}
      message={message}
      entryLabel={prompt}
      backspaceLabel={backspaceLabel}
      testID={`${testID}-pad`}
    />
  );
  const link = footer === undefined ? null : <View style={styles.footer}>{footer}</View>;
  // The same two boxes in both layouts, so turning the tablet mid-entry keeps the digits typed:
  // only the link moves, and the pad never changes place in the tree.
  return (
    <View style={[styles.root, sideBySide ? styles.rootSide : null]} testID={testID}>
      <View style={sideBySide ? styles.side : styles.stack}>
        {who}
        {question}
        {sideBySide ? link : null}
      </View>
      <View style={sideBySide ? styles.side : styles.stack}>
        {pad}
        {sideBySide ? null : link}
      </View>
    </View>
  );
}

/** Big avatar, name and role: whose PIN this is. Also heads the locked-out state. */
export function PinPerson({
  person,
  testID,
}: {
  readonly person: PinEntryPerson;
  readonly testID: string;
}): React.JSX.Element {
  const role = roleLabel(person.roleKeys ?? []);
  return (
    <View style={styles.person} testID={testID}>
      <Avatar userId={person.id} initials={initialsOf(person.name)} size="hero" />
      <Text style={styles.name} testID={`${testID}-name`}>
        {person.name}
      </Text>
      {role === '' ? null : <Text style={styles.role}>{role}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { alignItems: 'center', paddingTop: space.md },
  rootSide: { flexDirection: 'row', justifyContent: 'center', gap: space['3xl'] },
  stack: { alignItems: 'center' },
  side: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  person: { alignItems: 'center', marginBottom: space.lg },
  name: { ...type.title, color: color.text, marginTop: space.md, textAlign: 'center' },
  role: { ...type.bodySm, color: color.textMuted, textAlign: 'center' },
  prompt: { ...type.body, color: color.text, marginBottom: space.md, textAlign: 'center' },
  promptAlone: {
    ...type.heading,
    color: color.text,
    marginTop: space.xl,
    marginBottom: space.lg,
    textAlign: 'center',
  },
  footer: { marginTop: space.sm, alignItems: 'center' },
  busy: { alignItems: 'center', gap: space.md, marginTop: space.xl },
});
