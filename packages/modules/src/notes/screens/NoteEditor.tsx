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
 *
 * ── THE DRAFT SEAM (SEC-AUTH-08; api/02-auth §6.4; task 155) ────────────────────────────────────
 * Everything above lives in `useState`, which is exactly why an idle lock used to destroy it: the
 * lock unmounts this whole surface (the gate routes to the switcher) and local state goes with it.
 * Task 133 shipped the retention PATH — `updateWorkspace` → `SessionManager.saveWork(userId, …)` →
 * restored by the SAME user's unlock — and disclosed that NOTHING wrote into it. {@link NoteDraft}
 * plus `onDraftChange`/`restoredDraft` are that missing producer and consumer.
 *
 * TWO RULES, BOTH LOAD-BEARING:
 *  1. The draft is published on EVERY edit, never on a lock signal. This screen cannot see a lock —
 *     by the time one fires, the shell no longer knows whose work was on screen (shell-session.ts's
 *     header states the race). Write-through means the lock is a pure identity-clearing event.
 *  2. The draft is RELEASED only where the user CONSENTED to lose it — `save()`, and the `proceed`
 *     arm of the §8.1 discard gate. Never in an unmount cleanup: an unmount is what a LOCK looks
 *     like from in here, so releasing there would delete the work retention exists to keep.
 */
import type { MediaRef } from '@bolusi/schemas';
import { zMediaRef } from '@bolusi/schemas';
import { t, translateErrorCode } from '@bolusi/i18n';
import { z } from 'zod';
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
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { tn } from './i18n.js';
import { useCommand, useNotesRuntime, useQuery } from './runtime.js';

/**
 * The editor's discard gate, published to the host shell (design-system §8.1; task 145).
 *
 * The shell mounts this editor inside a module surface it navigates PRIVATELY, so a hardware-back or a
 * header-chrome tap used to leave by unmounting the surface — dropping the draft with none of the
 * confirm the header back already runs. This is the ONE seam that lets those paths ask the live editor
 * "may I leave?" instead: the editor answers by running the SAME `dirty ⇒ ConfirmSheet` gate its own
 * back uses, and calls `proceed` only once the user consents (immediately when the draft is clean).
 */
export type DiscardGuard = (proceed: () => void) => void;

/**
 * One editor's in-flight work, as retained across a lock (task 155). The MODULE owns this shape —
 * the shell stores it opaquely under the module's id (`UserWorkspace.drafts`, which is typed
 * `Record<string, unknown>` precisely so no shell code has to know what is inside).
 *
 * `mode` + `noteId` ride along because restoring the TEXT without restoring WHICH SCREEN it belonged
 * to would drop a half-typed body edit into a new-note form and file it as a second note.
 */
export interface NoteDraft {
  readonly mode: 'create' | 'edit';
  /** The note being edited in `edit` mode; `null` in `create` (no note exists yet). */
  readonly noteId: string | null;
  readonly title: string;
  readonly body: string;
  readonly mediaRef: MediaRef | null;
}

/**
 * The retained value comes back as `unknown` (the shell holds it opaquely), so it is PARSED, not
 * cast. Reuses `zMediaRef` rather than restating the ref's shape (§2.8) — a hand-rolled second
 * definition is how a ref that no longer validates gets rendered as if it did.
 *
 * A value that does not parse yields `null` — the same "nothing retained" answer as an absent draft.
 * The failure mode has to be "the user sees an empty editor" (annoying, safe), never a crash on a
 * terminal somebody is mid-shift on (`restoreWorkspace` makes the identical trade).
 */
const zNoteDraft = z.strictObject({
  mode: z.enum(['create', 'edit']),
  noteId: z.string().nullable(),
  title: z.string(),
  body: z.string(),
  mediaRef: zMediaRef.nullable(),
});

export function parseNoteDraft(value: unknown): NoteDraft | null {
  const parsed = zNoteDraft.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export interface NoteEditorProps {
  readonly mode: 'create' | 'edit';
  /** Required in `edit` mode — the note whose body is being edited. */
  readonly noteId?: string | undefined;
  /**
   * Work this user had in flight when a lock ended their last session (SEC-AUTH-08; task 155), or
   * `null`/absent for a fresh editor. Read ONCE, into the form's initial state — after that the form
   * owns the text, so a re-render carrying a newer retained copy cannot stomp what is being typed.
   */
  readonly restoredDraft?: NoteDraft | null | undefined;
  /**
   * Publish the in-flight draft to the shell's per-user retention (task 155), or `null` when there is
   * nothing to retain. Called on every edit — see the file header for why this is not lock-triggered.
   * Absent in tests that mount the editor directly, and in any host with no session to retain into.
   */
  readonly onDraftChange?: ((draft: NoteDraft | null) => void) | undefined;
  readonly syncChip: ReactNode;
  readonly avatar: ReactNode;
  /** Return to the list. Called the instant the command is fired — optimistic, no wait (§4.2). */
  readonly onDone: () => void;
  /** Leave without saving (already confirmed if there was unsaved input). */
  readonly onCancel: () => void;
  /**
   * Publish the discard gate to the host shell (task 145). The editor registers a {@link DiscardGuard}
   * while it is mounted and `null` on unmount, so the shell can route a hardware-back or a header-chrome
   * tap through the editor's own dirty-check + ConfirmSheet rather than unmounting the form under a
   * half-written draft. Absent in tests that mount the editor directly.
   */
  readonly onRegisterDiscardGuard?: ((guard: DiscardGuard | null) => void) | undefined;
  readonly testID?: string | undefined;
}

export function NoteEditor(props: NoteEditorProps): React.JSX.Element {
  if (props.mode === 'create') {
    return (
      <EditorForm
        mode="create"
        initialTitle=""
        initialBody=""
        // A retained draft for the OTHER mode is not this form's: the shell restores the surface to
        // the mode the draft names, so a mismatch here means a stale copy, and stale work is exactly
        // what must not be typed over.
        restoredDraft={props.restoredDraft?.mode === 'create' ? props.restoredDraft : null}
        onDraftChange={props.onDraftChange}
        syncChip={props.syncChip}
        avatar={props.avatar}
        onDone={props.onDone}
        onCancel={props.onCancel}
        onRegisterDiscardGuard={props.onRegisterDiscardGuard}
        testID={props.testID}
      />
    );
  }
  return <EditNoteLoader {...props} noteId={props.noteId ?? ''} />;
}

/** Edit mode's data load (04 §7) — the four §5 states, then the form prefilled from the note. */
function EditNoteLoader({
  noteId,
  restoredDraft,
  onDraftChange,
  syncChip,
  avatar,
  onDone,
  onCancel,
  onRegisterDiscardGuard,
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
          hint={t('core.unauthorized.askOwner')}
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
          // The NOTE'S stored body stays the baseline even when a draft is restored over it — that is
          // what `dirty` is measured against, so a restored edit is correctly still dirty and its
          // discard gate still fires.
          initialBody={query.data.body}
          restoredDraft={
            restoredDraft?.mode === 'edit' && restoredDraft.noteId === noteId ? restoredDraft : null
          }
          onDraftChange={onDraftChange}
          syncChip={syncChip}
          avatar={avatar}
          onDone={onDone}
          onCancel={onCancel}
          onRegisterDiscardGuard={onRegisterDiscardGuard}
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
  /** Already narrowed to THIS form's mode/note by the container — see the two call sites. */
  readonly restoredDraft?: NoteDraft | null | undefined;
  readonly onDraftChange?: ((draft: NoteDraft | null) => void) | undefined;
  readonly syncChip: ReactNode;
  readonly avatar: ReactNode;
  readonly onDone: () => void;
  readonly onCancel: () => void;
  readonly onRegisterDiscardGuard?: ((guard: DiscardGuard | null) => void) | undefined;
  readonly testID?: string | undefined;
}

function EditorForm({
  mode,
  noteId,
  initialTitle,
  initialBody,
  restoredDraft,
  onDraftChange,
  syncChip,
  avatar,
  onDone,
  onCancel,
  onRegisterDiscardGuard,
  testID = 'notes.editor',
}: EditorFormProps): React.JSX.Element {
  const runtime = useNotesRuntime();
  const createNote = useCommand((rt) => rt.createNote);
  const editNoteBody = useCommand((rt) => rt.editNoteBody);

  // The retained draft seeds INITIAL state only (task 155). Deliberately not an effect that syncs on
  // every change: this form's own publish is what produces the retained copy, so syncing back would
  // be a loop, and a late-arriving copy would overwrite the keystroke that produced it.
  const [title, setTitle] = useState(restoredDraft?.title ?? initialTitle);
  const [body, setBody] = useState(restoredDraft?.body ?? initialBody);
  // The WHOLE signed ref, not just the id: the v3 `note_created` payload carries it so that a
  // device pulling this note can download-verify the photo against a hash our signature covers
  // (06 §6 / 05 §2). Keeping only the id here is what made remote thumbnails unverifiable.
  const [mediaRef, setMediaRef] = useState<MediaRef | null>(restoredDraft?.mediaRef ?? null);
  const [titleMissing, setTitleMissing] = useState(false);
  const [discardPrompt, setDiscardPrompt] = useState(false);
  /**
   * What to run once the user consents to leave (task 145). The header back leaves toward `onCancel`;
   * a host-chrome tap leaves toward wherever the shell was navigating. Stored so the ONE ConfirmSheet
   * can serve both — `null` means "use the header back's default". Held as a nullary thunk, so the
   * updater form is mandatory (`setPendingLeave(() => proceed)`) or React would call it as a reducer.
   */
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);

  const dirty =
    mode === 'create'
      ? title.trim() !== '' || body !== '' || mediaRef !== null
      : body !== initialBody;

  /**
   * WRITE-THROUGH RETENTION (task 155). Publishes on every edit, and publishes `null` while the form
   * is clean — so a user who opens the editor and types nothing leaves no empty-draft artifact behind
   * to be "restored" onto their next unlock. `dirty` is therefore the exact retention predicate, and
   * it is the SAME one the §8.1 discard gate uses: there is one definition of "there is work here".
   *
   * NO CLEANUP FUNCTION, deliberately. Unmount is what a LOCK looks like from inside this form (the
   * gate swaps the whole surface for the switcher), so releasing on unmount would delete the draft at
   * exactly the moment retention exists to save it. Release happens where the user CONSENTS — see
   * `releaseDraft`'s call sites.
   */
  useEffect(() => {
    onDraftChange?.(dirty ? { mode, noteId: noteId ?? null, title, body, mediaRef } : null);
  }, [dirty, mode, noteId, title, body, mediaRef, onDraftChange]);

  /** The user consented to lose this work (saved it, or confirmed the discard). Stop retaining it. */
  const releaseDraft = (): void => onDraftChange?.(null);

  /**
   * The one discard gate every leave path shares (design-system §8.1): a dirty draft raises the
   * ConfirmSheet and defers `proceed` until confirm; a clean one leaves at once. The header back, the
   * hardware back and every header-chrome tap all run THIS, so none can drop a draft the others would
   * have guarded.
   */
  const requestLeave = (proceed: () => void): void => {
    if (dirty) {
      setPendingLeave(() => proceed);
      setDiscardPrompt(true);
      return;
    }
    // Clean, so there is nothing to confirm — but there may still be a retained copy from earlier in
    // this session (typed, then deleted back to empty). Release it, or a later lock would "restore"
    // an editor the user had already emptied.
    releaseDraft();
    proceed();
  };

  // Publish the gate to the host shell for as long as the form is mounted (task 145). Re-registered
  // when `dirty` flips so the shell's copy always reflects whether there is a draft to protect; the
  // cleanup hands back `null` so a leave attempt after unmount can never reach a stale editor.
  useEffect(() => {
    onRegisterDiscardGuard?.((proceed) => {
      if (dirty) {
        setPendingLeave(() => proceed);
        setDiscardPrompt(true);
        return;
      }
      onDraftChange?.(null);
      proceed();
    });
    return () => onRegisterDiscardGuard?.(null);
  }, [dirty, onRegisterDiscardGuard, onDraftChange]);

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
      // The work is now a durable, appended op — retaining a second copy would re-open this editor
      // on the next unlock and invite the user to file the same note twice (task 155).
      releaseDraft();
      onDone();
      return;
    }
    if (noteId === undefined) return; // guaranteed by the container; guard defensively
    void editNoteBody({ noteId, body });
    releaseDraft();
    onDone();
  };

  const requestCancel = (): void => requestLeave(onCancel);

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
            // Leave toward whatever asked (a chrome tap's destination), or the header back's default.
            const proceed = pendingLeave ?? onCancel;
            setPendingLeave(null);
            // THE CONSENT (task 155). "Discard" has to mean discarded: without this the text would
            // survive in retention and the next idle-lock unlock would hand back a note the user had
            // explicitly thrown away. This is where retention composes with §8.1's gate rather than
            // fighting it — the gate decides, this line obeys.
            releaseDraft();
            proceed();
          }}
          cancelLabel={t('core.action.back')}
          onCancel={() => {
            setDiscardPrompt(false);
            setPendingLeave(null);
          }}
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
