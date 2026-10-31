// The site's front page: type the code from the slip when the QR will not scan. A valid code opens
// the same page the QR does.
import { STATUS_PATH_PREFIX, normalizeStatusCode, tn } from '@bolusi/modules/repair/customer-page';
import { BrandMark, Button, TextField } from '@bolusi/ui-web';
import { useEffect, useState } from 'react';

export function LookupPage({
  onOpen = (path) => window.location.assign(path),
}: {
  /** Where a valid code goes; tests catch it. */
  readonly onOpen?: (path: string) => void;
}): React.JSX.Element {
  const [typed, setTyped] = useState('');
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    document.title = tn('repair.customerPage.lookup.title');
  }, []);

  return (
    <main className="mx-auto flex min-h-full w-full max-w-[480px] flex-col gap-6 px-4 py-10">
      <BrandMark variant="wordmark" size={24} />
      <div className="flex flex-col gap-1">
        <h1 className="text-title font-semibold text-text">
          {tn('repair.customerPage.lookup.title')}
        </h1>
        <p className="text-body text-text-muted">{tn('repair.customerPage.lookup.hint')}</p>
      </div>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const code = normalizeStatusCode(typed);
          if (code === null) {
            setInvalid(true);
            return;
          }
          onOpen(`${STATUS_PATH_PREFIX}${code}`);
        }}
      >
        <TextField
          label={tn('repair.customerPage.lookup.label')}
          placeholder={tn('repair.customerPage.lookup.placeholder')}
          value={typed}
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          inputClassName="h-11 font-semibold uppercase tracking-wider placeholder:font-normal placeholder:normal-case placeholder:tracking-normal"
          error={invalid ? tn('repair.customerPage.lookup.invalid') : undefined}
          onChange={(event) => {
            setTyped(event.target.value);
            setInvalid(false);
          }}
        />
        <Button
          type="submit"
          variant="primary"
          size="lg"
          label={tn('repair.customerPage.lookup.submit')}
        />
      </form>
    </main>
  );
}
