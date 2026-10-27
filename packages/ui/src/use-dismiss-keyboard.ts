import { useEffect } from 'react';
import { Keyboard } from 'react-native';

/**
 * Close the keyboard when an overlay opens (ConfirmSheet, Sheet, PhotoViewer). A sheet asked for
 * while a field was focused otherwise opened under the keyboard, its buttons out of sight (first
 * Android QA run).
 *
 * It runs once, on mount. A parent's effect runs after its children's, so an overlay that one day
 * holds an `autoFocus` field of its own would close that field's keyboard too: such an overlay
 * should focus its field after this, not through `autoFocus`.
 */
export function useDismissKeyboard(): void {
  useEffect(() => {
    Keyboard.dismiss();
  }, []);
}
