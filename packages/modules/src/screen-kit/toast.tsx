// Toasts: the one way both apps say a step is done. A short note at the bottom of the window that
// goes by itself, with Batalkan when the step can be taken back. Errors and refusals stay inline
// beside what they are about, a dialog comes only before a destructive or money-heavy step, and a
// banner is kept for a lasting state (docs/design-guide.md, "Feedback").
//
// Batalkan takes back a small slip (a wrong status, the wrong technician) by recording the change
// that reverses it. Nothing is held back or deleted: the slip and its reverse are both ordinary,
// server-checked changes. Money, stock leaving and what the customer sees keep their confirms and
// formal reversals instead (flow-navigation.md).
//
// One toast shows at a time, app-wide, so it survives the step closing behind it. Each app draws
// it (`ToastHost` on the phone and on the PC) from `useShownToast`.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

/** How long a done note stays. */
export const TOAST_MS = 5_000;
/** How long Batalkan stays offered: a little longer, so it can be reached. */
export const UNDO_WINDOW_MS = 8_000;

export interface ToastOffer {
  /** What was just done, already localized ("Ditandai tunggu sparepart."). */
  readonly message: string;
  /** Records the reverse change. A refusal comes back as the error it throws. */
  readonly undo?: (() => Promise<void>) | undefined;
}

/** The toast on screen, with what a press of Batalkan, its close and its timing out do. */
export interface ShownToast {
  readonly key: number;
  readonly message: string;
  /** Batalkan, when the step can be taken back. */
  readonly undo: (() => void) | undefined;
  /** Whether the reverse is being recorded right now. */
  readonly undoing: boolean;
  /** The reverse failed: the error, for the host to name. */
  readonly failed: unknown;
  readonly dismiss: () => void;
}

interface ToastContextValue {
  readonly show: ((offer: ToastOffer) => void) | null;
  readonly shown: ShownToast | null;
}

const ToastContext = createContext<ToastContextValue>({ show: null, shown: null });

export function ToastProvider({
  children,
}: {
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const [state, setState] = useState<{
    readonly key: number;
    readonly offer: ToastOffer;
    readonly undoing: boolean;
    readonly failed: unknown;
  } | null>(null);
  const keyRef = useRef(0);

  const show = useCallback((next: ToastOffer) => {
    keyRef.current += 1;
    setState({ key: keyRef.current, offer: next, undoing: false, failed: undefined });
  }, []);

  // The toast goes after its window; while the reverse is being recorded it waits for that.
  const key = state?.key;
  const undoing = state?.undoing === true;
  const failed = state?.failed;
  const lasts = state?.offer.undo === undefined ? TOAST_MS : UNDO_WINDOW_MS;
  useEffect(() => {
    if (key === undefined || undoing) return;
    const timer = setTimeout(
      () => setState((current) => (current?.key === key ? null : current)),
      lasts,
    );
    return () => clearTimeout(timer);
  }, [key, undoing, failed, lasts]);

  const shown = useMemo((): ShownToast | null => {
    if (state === null) return null;
    const { key, offer } = state;
    const dismiss = (): void => setState((current) => (current?.key === key ? null : current));
    const reverse = offer.undo;
    return {
      key,
      message: offer.message,
      undoing: state.undoing,
      failed: state.failed,
      dismiss,
      undo:
        reverse === undefined
          ? undefined
          : () => {
              if (state.undoing) return;
              setState((current) =>
                current?.key === key ? { ...current, undoing: true } : current,
              );
              reverse().then(dismiss, (error: unknown) =>
                setState((current) =>
                  current?.key === key ? { ...current, undoing: false, failed: error } : current,
                ),
              );
            },
    };
  }, [state]);

  const value = useMemo(() => ({ show, shown }), [show, shown]);
  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

/**
 * Show a toast; null outside a `ToastProvider` (a screen drawn on its own in a test), where the
 * screen keeps the note itself (`useDoneNote`).
 */
export function useToast(): ((offer: ToastOffer) => void) | null {
  return useContext(ToastContext).show;
}

/** For the host that draws it: the toast showing now, or null. */
export function useShownToast(): ShownToast | null {
  return useContext(ToastContext).shown;
}

/**
 * What a screen says when a step is done: a toast in the apps, or, drawn on its own without a
 * provider, a note the screen shows itself (`note`). `say(null)` clears the screen's own note.
 * A note kept as a message key is put in words by `words`.
 */
export function useDoneNote(): DoneNote<string>;
export function useDoneNote<T>(words: (note: T) => string): DoneNote<T>;
export function useDoneNote<T>(words?: (note: T) => string): DoneNote<T> {
  const show = useToast();
  const [note, setNote] = useState<T | null>(null);
  const wordsRef = useRef(words);
  wordsRef.current = words;
  const say = useCallback(
    (message: T | null, undo?: () => Promise<void>) => {
      if (show === null || message === null) {
        setNote(message);
        return;
      }
      setNote(null);
      const put = wordsRef.current;
      show({ message: put === undefined ? String(message) : put(message), undo });
    },
    [show],
  );
  return { note, say };
}

export interface DoneNote<T> {
  readonly note: T | null;
  readonly say: (message: T | null, undo?: () => Promise<void>) => void;
}
