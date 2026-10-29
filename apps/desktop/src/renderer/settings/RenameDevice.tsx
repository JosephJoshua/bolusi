// Renaming this PC from Settings > Komputer ini. Online only: the server takes the name first, and
// the core then shows it here; a refusal keeps the dialog open with the reason.
import { staffAdminFailure, type StaffAdminFailure } from '@bolusi/core';
import {
  deviceNameProblem,
  RENAME_FAILURE_KEY,
  RENAME_PROBLEM_KEY,
} from '@bolusi/device/models/settings/rename';
import { t } from '@bolusi/i18n';
import { Banner, Button, Dialog, TextField } from '@bolusi/ui-web';
import { useState } from 'react';

/** What a refused rename says on the PC: offline asks to connect this computer, not a phone. */
function failureText(failure: StaffAdminFailure): string {
  return failure === 'offline'
    ? t('auth.pc.settings.staffOffline')
    : t(RENAME_FAILURE_KEY[failure]);
}

export function RenameDeviceDialog({
  current,
  onRename,
  onClose,
}: {
  readonly current: string;
  /** REJECTS with a `StaffAdminError`. */
  readonly onRename: (name: string) => Promise<void>;
  readonly onClose: () => void;
}): React.JSX.Element {
  const [name, setName] = useState(current);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<StaffAdminFailure | null>(null);
  const problem = deviceNameProblem(name);

  const save = (): void => {
    setAttempted(true);
    if (problem !== null || busy) return;
    if (name.trim() === current) {
      onClose();
      return;
    }
    setBusy(true);
    setFailure(null);
    onRename(name.trim()).then(onClose, (error: unknown) => {
      setBusy(false);
      setFailure(staffAdminFailure(error));
    });
  };

  return (
    <Dialog
      open
      onRequestClose={() => (busy ? undefined : onClose())}
      title={t('auth.rename.titlePc')}
      closeLabel={t('core.action.close')}
      size="sm"
      testId="desktop.rename"
      banner={
        failure === null ? undefined : (
          <Banner
            tone={failure === 'offline' ? 'warning' : 'danger'}
            message={failureText(failure)}
          />
        )
      }
      footer={
        <>
          <Button label={t('core.action.cancel')} onClick={onClose} disabled={busy} />
          <Button
            label={t('core.action.save')}
            variant="primary"
            onClick={save}
            busy={busy}
            data-testid="desktop.rename.save"
          />
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <TextField
          label={t('auth.pc.deviceNameField')}
          hint={t('auth.rename.hint')}
          placeholder={t('auth.pc.deviceNamePlaceholder')}
          error={attempted && problem !== null ? t(RENAME_PROBLEM_KEY[problem]) : undefined}
          value={name}
          onChange={(event) => {
            setFailure(null);
            setName(event.target.value);
          }}
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          autoFocus
          data-testid="desktop.rename.name"
        />
      </form>
    </Dialog>
  );
}
