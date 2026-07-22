/**
 * NoteEditor (design-system §8.6) — create or edit-body, as a full-screen flow (§3.10 — no modals).
 *
 * THE OPTIMISTIC SAVE IS THE POINT (design-system §4.1/§4.2). Save fires the command and returns to
 * the list in the SAME tick — no spinner, no await on the network (a local command appends + projects
 * synchronously, 04 §5.1). A blocking `await` here is the falsified defect: it would make the one
 * screen that must feel instant wait on work the user was promised never blocks them.
 *
 * Title is set once at creation (01 §9 — v0 has no title edit), so edit mode shows it read-only and
 * edits only the body. Edit mode LOADS its note through `useQuery` (04 §7) and therefore ships all
 * four §5 states; create mode has nothing to load and is the form directly. Media attach is a
 * create-only affordance (the v3 `note_created` payload carries the whole `mediaRef`) and reuses the
 * task-82 capture flow through the runtime seam.
 */
import type { MediaRef } from '@bolusi/schemas';
import { t, translateErrorCode } from '@bolusi/i18n';
import {
  AppShell,
  Button,
  ConfirmSheet,
  EmptyState,
  ErrorState,
  Icon,
  LoadingState,
  TextInput,
  UnauthorizedState,
  color,
  size,
  space,
  type,
} from '@bolusi/ui';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { tn } from './i18n.js';
import { useCommand, useNotesRuntime, useQuery } from './runtime.js';

export interface NoteEditorProps {
  readonly mode: 'create' | 'edit';
  /** Required in `edit` mode — the note whose body is being edited. */
  readonly noteId?: string | undefined;
  readonly syncChip: ReactNode;
  readonly avatar: ReactNode;
  /** Return to the list. Called the instant the command is fired — optimistic, no wait (§4.2). */
  readonly onDone: () => void;
  /** Leave without saving (already confirmed if there was unsaved input). */
  readonly onCancel: () => void;
  readonly testID?: string | undefined;
}

export function NoteEditor(props: NoteEditorProps): React.JSX.Element {
  if (props.mode === 'create') {
    return (
      <EditorForm
        mode="create"
        initialTitle=""
        initialBody=""
        syncChip={props.syncChip}
        avatar={props.avatar}
        onDone={props.onDone}
        onCancel={props.onCancel}
        testID={props.testID}
      />
    );
  }
  return <EditNoteLoader {...props} noteId={props.noteId ?? ''} />;
}

/** Edit mode's data load (04 §7) — the four §5 states, then the form prefilled from the note. */
function EditNoteLoader({
  noteId,
  syncChip,
  avatar,
  onDone,
  onCancel,
  testID = 'notes.editor',
}: NoteEditorProps & { readonly noteId: string }): React.JSX.Element {
  const [reloadNonce, setReloadNonce] = useState(0);
  const query = useQuery(
    async (rt) => (await rt.getNote({ noteId })).rows[0],
    `edit:${noteId}:${String(reloadNonce)}`,
  );

  const shell = (body: ReactNode): React.JSX.Element => (
    <AppShell
      title={t('core.action.edit')}
      titleVariant="detail"
      onBack={onCancel}
      backLabel={t('core.action.back')}
      syncChip={syncChip}
      avatar={avatar}
      testID={testID}
    >
      {body}
    </AppShell>
  );

  switch (query.status) {
    case 'loading':
      // The loading STATE is the wrapper (present at once); LoadingState delays its content 300 ms
      // to avoid a flash (§3.9), so the testID lives on the container, as `List` does.
      return shell(
        <View testID={`${testID}.loading`}>
          <LoadingState variant="spinner" />
        </View>,
      );
    case 'unauthorized':
      return shell(
        <UnauthorizedState
          title={t('core.errors.PERMISSION_DENIED')}
          backLabel={t('core.action.back')}
          onBack={onCancel}
          testID={`${testID}.unauthorized`}
        />,
      );
    case 'error':
      if (query.code === 'ENTITY_NOT_FOUND') {
        return shell(
          <EmptyState title={t('core.errors.ENTITY_NOT_FOUND')} testID={`${testID}.empty`} />,
        );
      }
      return shell(
        <ErrorState
          title={translateErrorCode(query.code)}
          errorCode={query.code}
          retryLabel={t('core.action.retry')}
          onRetry={() => setReloadNonce((current) => current + 1)}
          testID={`${testID}.error`}
        />,
      );
    case 'ready':
      if (query.data === undefined) {
        return shell(
          <EmptyState title={t('core.errors.ENTITY_NOT_FOUND')} testID={`${testID}.empty`} />,
        );
      }
      return (
        <EditorForm
          mode="edit"
          noteId={noteId}
          initialTitle={query.data.title}
          initialBody={query.data.body}
          syncChip={syncChip}
          avatar={avatar}
          onDone={onDone}
          onCancel={onCancel}
          testID={testID}
        />
      );
  }
}

interface EditorFormProps {
  readonly mode: 'create' | 'edit';
  readonly noteId?: string | undefined;
  readonly initialTitle: string;
  readonly initialBody: string;
  readonly syncChip: ReactNode;
  readonly avatar: ReactNode;
  readonly onDone: () => void;
  readonly onCancel: () => void;
  readonly testID?: string | undefined;
}

function EditorForm({
  mode,
  noteId,
  initialTitle,
  initialBody,
  syncChip,
  avatar,
  onDone,
  onCancel,
  testID = 'notes.editor',
}: EditorFormProps): React.JSX.Element {
  const runtime = useNotesRuntime();
  const createNote = useCommand((rt) => rt.createNote);
  const editNoteBody = useCommand((rt) => rt.editNoteBody);

  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState(initialBody);
  // The WHOLE signed ref, not just the id: the v3 `note_created` payload carries it so that a
  // device pulling this note can download-verify the photo against a hash our signature covers
  // (06 §6 / 05 §2). Keeping only the id here is what made remote thumbnails unverifiable.
  const [mediaRef, setMediaRef] = useState<MediaRef | null>(null);
  const [titleMissing, setTitleMissing] = useState(false);
  const [discardPrompt, setDiscardPrompt] = useState(false);

  const dirty =
    mode === 'create'
      ? title.trim() !== '' || body !== '' || mediaRef !== null
      : body !== initialBody;

  const attach = (): void => {
    void runtime.capturePhoto().then((captured) => {
      if (captured !== null) setMediaRef(captured.mediaRef);
    });
  };

  const save = (): void => {
    if (mode === 'create') {
      const trimmed = title.trim();
      // Client-side mirror of the command's `title.min(1)` so the user sees `titleRequired` inline
      // BEFORE the optimistic return — the command would also reject it, but not on this screen.
      if (trimmed === '') {
        setTitleMissing(true);
        return;
      }
      // OPTIMISTIC: fire and return. NOT awaited — see the file header. Breaking this to `await`
      // is the falsified defect the mounted test reds on.
      void createNote({ title: trimmed, body, mediaRef });
      onDone();
      return;
    }
    if (noteId === undefined) return; // guaranteed by the container; guard defensively
    void editNoteBody({ noteId, body });
    onDone();
  };

  const requestCancel = (): void => {
    if (dirty) {
      setDiscardPrompt(true);
      return;
    }
    onCancel();
  };

  return (
    <AppShell
      title={mode === 'create' ? tn('notes.action.new') : t('core.action.edit')}
      titleVariant="detail"
      onBack={requestCancel}
      backLabel={t('core.action.back')}
      syncChip={syncChip}
      avatar={avatar}
      bottomAction={
        <Button label={t('core.action.save')} onPress={save} testID={`${testID}.save`} />
      }
      testID={testID}
    >
      <View style={styles.field}>
        <TextInput
          label={tn('notes.editor.titleField')}
          value={mode === 'create' ? title : initialTitle}
          onChangeText={(next) => {
            if (mode !== 'create') return; // title is read-only in edit (01 §9)
            setTitle(next);
            if (titleMissing && next.trim() !== '') setTitleMissing(false);
          }}
          errorMessage={titleMissing ? tn('notes.editor.titleRequired') : undefined}
          disabled={mode !== 'create'}
          autoFocus={mode === 'create'}
          testID={`${testID}.title`}
        />
      </View>

      <View style={styles.field}>
        {/*
          The body is the note (§8.6) — free-form prose a mechanic types on a 360 dp phone, so it
          MUST wrap. Single-line (RN's default, and what this field shipped as) clipped it at
          roughly 35 characters with no wrap and no scroll: the user could not read back what they
          had just written. `multiline` is the field's only correct variant here.
        */}
        <TextInput
          label={tn('notes.editor.bodyField')}
          value={body}
          onChangeText={setBody}
          multiline
          testID={`${testID}.body`}
        />
      </View>

      {mode === 'create' ? (
        <View style={styles.attachRow} testID={`${testID}.attachRow`}>
          <Button
            label={tn('notes.action.attachPhoto')}
            variant="secondary"
            onPress={attach}
            testID={`${testID}.attach`}
          />
          {mediaRef === null ? null : (
            <View style={styles.attached} testID={`${testID}.attached`}>
              <Icon name="attachment" size={size.iconInline} color={color.success} />
              <Text style={styles.attachedText}>{tn('notes.action.attachPhoto')}</Text>
            </View>
          )}
        </View>
      ) : null}

      {discardPrompt ? (
        <ConfirmSheet
          // Reuses the app's established "abandon this flow" idiom (EnrollmentScreen) — the notes
          // catalog carries no dedicated discard-confirm copy (flagged for the next i18n pass).
          title={t('core.action.cancel')}
          confirmLabel={t('core.action.confirm')}
          onConfirm={() => {
            setDiscardPrompt(false);
            onCancel();
          }}
          cancelLabel={t('core.action.back')}
          onCancel={() => setDiscardPrompt(false)}
          testID={`${testID}.discard`}
        />
      ) : null}
    </AppShell>
  );
}

const styles = StyleSheet.create({
  field: { marginBottom: space.lg },
  attachRow: { marginTop: space.sm },
  attached: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.md },
  attachedText: { ...type.bodySm, color: color.textMuted },
});
