// A dialog for a short task on top of the page (pick a technician, change a price): title, body,
// and the answer buttons bottom right with the primary last. Escape and the close button leave;
// a dialog holding unsaved input asks first through `onRequestClose`.
import * as RadixDialog from '@radix-ui/react-dialog';
import { clsx } from 'clsx';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

export interface DialogProps {
  readonly open: boolean;
  /** Called when the user asks to leave (Escape, the close button, the scrim). */
  readonly onRequestClose: () => void;
  readonly title: string;
  readonly description?: ReactNode;
  readonly closeLabel: string;
  readonly size?: 'sm' | 'md' | 'lg' | undefined;
  /** Above the body, always visible: a refusal or a "changed elsewhere" notice. */
  readonly banner?: ReactNode;
  readonly footer?: ReactNode;
  readonly children?: ReactNode;
  readonly testId?: string | undefined;
}

const WIDTH = { sm: 'max-w-[420px]', md: 'max-w-[560px]', lg: 'max-w-[760px]' };

export function Dialog({
  open,
  onRequestClose,
  title,
  description,
  closeLabel,
  size = 'md',
  banner,
  footer,
  children,
  testId,
}: DialogProps): React.JSX.Element {
  return (
    <RadixDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onRequestClose();
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-overlay/40" />
        <RadixDialog.Content
          data-testid={testId}
          // A stray click beside a dialog must not throw away what was typed in it; it closes
          // through its own buttons or Escape (which a dialog with input can intercept).
          onPointerDownOutside={(event) => event.preventDefault()}
          aria-describedby={description === undefined ? undefined : `${testId ?? 'dialog'}-desc`}
          className={clsx(
            'fixed left-1/2 top-1/2 z-50 flex max-h-[min(88vh,820px)] w-[calc(100vw-48px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-md bg-surface shadow-2xl focus:outline-none',
            WIDTH[size],
          )}
        >
          <div className="flex items-start gap-4 px-6 pb-2 pt-5">
            <div className="min-w-0 flex-1">
              <RadixDialog.Title className="text-title font-bold text-text">
                {title}
              </RadixDialog.Title>
              {description === undefined ? null : (
                <RadixDialog.Description
                  id={`${testId ?? 'dialog'}-desc`}
                  className="mt-1 text-body text-text-muted"
                >
                  {description}
                </RadixDialog.Description>
              )}
            </div>
            <RadixDialog.Close
              aria-label={closeLabel}
              className="-mr-2 flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-sm text-text-muted hover:bg-surface-alt hover:text-text"
            >
              <X size={18} aria-hidden />
            </RadixDialog.Close>
          </div>
          {banner === undefined || banner === null ? null : (
            <div className="px-6 pt-2">{banner}</div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">{children}</div>
          {footer === undefined ? null : (
            <div className="flex items-center justify-end gap-3 border-t border-border px-6 py-4">
              {footer}
            </div>
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
