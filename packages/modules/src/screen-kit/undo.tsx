// Batalkan (undo): a small slip (a wrong status, the wrong technician) is taken back from a toast for a
// few seconds after it, by recording the change that reverses it. Nothing is held back or deleted:
// the slip and its reverse are both ordinary, server-checked changes. Money, stock leaving and
// what the customer sees keep their confirms and formal reversals instead (flow-navigation.md).
//
// One offer shows at a time, app-wide, so it survives the step closing behind it. Each app draws
// it (`UndoHost` on the phone, the PC's own) from `useShownUndo`.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

/** How long Batalkan stays offered. */
export const UNDO_WINDOW_MS = 8_000;

export interface UndoOffer {
  /** What was just done, already localized ("Ditandai tunggu sparepart"). */
  readonly message: string;
  /** Records the reverse change. A refusal comes back as the error it throws. */
  readonly undo: () => Promise<void>;
}

/** The offer on screen, with what a press of Batalkan and its timing out do. */
export interface ShownUndo {
  readonly key: number;
  readonly message: string;
  /** Whether the reverse is being recorded right now. */
  readonly undoing: boolean;
  /** The reverse failed: the error, for the host to name. */
  readonly failed: unknown;
  readonly undo: () => void;
  readonly dismiss: () => void;
}

interface UndoContextValue {
  readonly offer: ((offer: UndoOffer) => void) | null;
  readonly shown: ShownUndo | null;
}

const UndoContext = createContext<UndoContextValue>({ offer: null, shown: null });

export function UndoProvider({
  children,
}: {
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const [state, setState] = useState<{
    readonly key: number;
    readonly offer: UndoOffer;
    readonly undoing: boolean;
    readonly failed: unknown;
  } | null>(null);
  const keyRef = useRef(0);

  const offer = useCallback((next: UndoOffer) => {
    keyRef.current += 1;
    setState({ key: keyRef.current, offer: next, undoing: false, failed: undefined });
  }, []);

  // The offer goes after its window; while the reverse is being recorded it waits for that.
  const key = state?.key;
  const undoing = state?.undoing === true;
  const failed = state?.failed;
  useEffect(() => {
    if (key === undefined || undoing) return;
    const timer = setTimeout(
      () => setState((current) => (current?.key === key ? null : current)),
      UNDO_WINDOW_MS,
    );
    return () => clearTimeout(timer);
  }, [key, undoing, failed]);

  const shown = useMemo((): ShownUndo | null => {
    if (state === null) return null;
    const { key } = state;
    const dismiss = (): void => setState((current) => (current?.key === key ? null : current));
    return {
      key,
      message: state.offer.message,
      undoing: state.undoing,
      failed: state.failed,
      dismiss,
      undo: () => {
        if (state.undoing) return;
        setState((current) => (current?.key === key ? { ...current, undoing: true } : current));
        state.offer
          .undo()
          .then(dismiss, (error: unknown) =>
            setState((current) =>
              current?.key === key ? { ...current, undoing: false, failed: error } : current,
            ),
          );
      },
    };
  }, [state]);

  const value = useMemo(() => ({ offer, shown }), [offer, shown]);
  return <UndoContext.Provider value={value}>{children}</UndoContext.Provider>;
}

/**
 * Offer Batalkan for a change just recorded; null outside an `UndoProvider` (a screen drawn on its
 * own), where the screen says what it did in its own way instead.
 */
export function useOfferUndo(): ((offer: UndoOffer) => void) | null {
  return useContext(UndoContext).offer;
}

/** For the host that draws it: the offer showing now, or null. */
export function useShownUndo(): ShownUndo | null {
  return useContext(UndoContext).shown;
}
