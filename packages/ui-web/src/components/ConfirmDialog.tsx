import { Button } from './Button.js';
import { Dialog } from './Dialog.js';

/** Asks once before something that cannot be taken back, saying what will happen. */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  closeLabel,
  destructive = false,
  onConfirm,
  onCancel,
  testId,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly closeLabel: string;
  readonly destructive?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly testId?: string | undefined;
}): React.JSX.Element {
  return (
    <Dialog
      open={open}
      onRequestClose={onCancel}
      title={title}
      description={message}
      closeLabel={closeLabel}
      size="sm"
      testId={testId}
      footer={
        <>
          {/* The safe answer has the focus, so a stray Enter keeps what is there. */}
          <Button
            label={cancelLabel}
            onClick={onCancel}
            autoFocus
            data-testid={`${testId ?? 'confirm'}.cancel`}
          />
          <Button
            label={confirmLabel}
            variant={destructive ? 'danger' : 'primary'}
            onClick={onConfirm}
            data-testid={`${testId ?? 'confirm'}.confirm`}
          />
        </>
      }
    />
  );
}
