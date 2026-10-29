// The printer and paper this PC prints slips on, set once in Settings instead of at every print,
// and a test page to check them. They are the PC's own settings, so anyone who prints may change
// them, and a pick saves at once.
import { t } from '@bolusi/i18n';
import {
  Banner,
  Button,
  Card,
  ChoiceList,
  IconButton,
  Section,
  Segmented,
  Skeleton,
  Switch,
  TextField,
} from '@bolusi/ui-web';
import { Printer, RefreshCw } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { useActionRunner } from '../../screen-kit/index.js';
import { tn } from '../i18n.js';
import {
  DESK_PAPERS,
  PAPER_KEY,
  paperRangeHint,
  useCustomPaperForm,
  useDevicePaper,
  useDevicePrinters,
  type DevicePaper,
} from '../paper.js';
import { useRepairRuntime } from '../runtime.js';
import { outputTestPage } from '../slip-output.js';
import { ActionError } from '../../screen-kit/desktop/index.js';
import { PrinterProblemBanner, usePrinterProblem } from './parts.js';

export function PrintSettings(): React.JSX.Element | null {
  const runtime = useRepairRuntime();
  const printing = runtime.printing;
  const paper = useDevicePaper(printing, DESK_PAPERS);
  const { state, choose, reload } = useDevicePrinters(printing?.printers);
  const runner = useActionRunner();
  const [problem, catchProblem, clearProblem] = usePrinterProblem();
  const [sent, setSent] = useState(false);
  if (printing === undefined) return null;
  const testId = 'repair.desk.printing';

  const installed = state.kind === 'ready' ? state.printers : [];
  const chosen = state.kind === 'ready' ? state.chosen : null;
  const gone = chosen !== null && !installed.some((p) => p.name === chosen);
  const canTest = printing.printers === undefined || (chosen !== null && !gone);

  const printTest = (): void => {
    setSent(false);
    clearProblem();
    void runner
      .run(() => catchProblem(outputTestPage(runtime, printing, DESK_PAPERS)))
      .then((outcome) => setSent(outcome === 'done'));
  };

  return (
    <Card testId={testId}>
      <Section
        title={tn('repair.printer.title')}
        action={
          printing.printers === undefined ? null : (
            <IconButton
              icon={RefreshCw}
              label={tn('repair.printer.refresh')}
              onClick={() => {
                setSent(false);
                clearProblem();
                reload();
              }}
              data-testid={`${testId}.refresh`}
            />
          )
        }
      >
        <p className="-mt-2 text-small text-text-muted">{tn('repair.printer.hint')}</p>
        {printing.printers === undefined ? null : (
          <Group label={tn('repair.printer.printer')}>
            {state.kind === 'loading' ? (
              <div className="flex flex-col gap-2" data-testid={`${testId}.loading`}>
                <Skeleton className="h-10" />
                <Skeleton className="h-10" />
              </div>
            ) : state.kind === 'failed' ? (
              <Banner
                tone="danger"
                message={tn('repair.printer.loadFailed')}
                action={
                  <Button
                    label={t('core.action.retry')}
                    size="sm"
                    variant="text"
                    onClick={reload}
                  />
                }
              />
            ) : installed.length === 0 ? (
              <p
                className="rounded-sm bg-surface-alt px-4 py-3 text-body text-text-muted"
                data-testid={`${testId}.none`}
              >
                {tn('repair.printer.none')}
              </p>
            ) : (
              <ChoiceList
                label={tn('repair.printer.printer')}
                options={installed.map((p) => ({ value: p.name, label: p.label }))}
                value={gone ? null : chosen}
                onChange={(name) => {
                  setSent(false);
                  clearProblem();
                  void choose(name);
                }}
                testId={`${testId}.printers`}
              />
            )}
            {gone ? (
              <Banner
                tone="warning"
                message={tn('repair.printer.gone', { name: chosen })}
                className="mt-2"
              />
            ) : null}
          </Group>
        )}
        <Group label={tn('repair.print.paper')}>
          <Segmented
            label={tn('repair.print.paper')}
            options={DESK_PAPERS.map((value) => ({ value, label: tn(PAPER_KEY[value]) }))}
            value={paper.choice}
            onChange={(next) => {
              setSent(false);
              void paper.choose(next);
            }}
            testId={`${testId}.paper`}
          />
        </Group>
        {paper.choice === 'custom' ? (
          <CustomSize device={paper} testId={`${testId}.size`} onChange={() => setSent(false)} />
        ) : null}
        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
          <Button
            label={tn('repair.testPage.print')}
            icon={Printer}
            variant="secondary"
            onClick={printTest}
            busy={runner.busy}
            disabled={!canTest}
            data-testid={`${testId}.test`}
          />
          {sent ? (
            <p role="status" className="text-small text-text-muted" data-testid={`${testId}.sent`}>
              {tn('repair.testPage.sent')}
            </p>
          ) : null}
        </div>
        <PrinterProblemBanner problem={problem} onDismiss={clearProblem} />
        <ActionError errorCode={runner.errorCode} onDismiss={runner.clearError} />
      </Section>
    </Card>
  );
}

/** The typed size, saved as it is typed, and whether it is the tractor-feed kind. */
function CustomSize({
  device,
  testId,
  onChange,
}: {
  readonly device: DevicePaper;
  readonly testId: string;
  readonly onChange: () => void;
}): React.JSX.Element {
  const form = useCustomPaperForm(device);
  const enter = (event: React.KeyboardEvent): void => {
    if (event.key === 'Enter') form.leave();
  };
  return (
    <div className="flex flex-col gap-3" data-testid={testId}>
      <div className="flex flex-wrap items-start gap-3">
        <TextField
          label={tn('repair.print.paperWidth')}
          value={form.width}
          onChange={(event) => {
            onChange();
            form.setWidth(event.target.value);
          }}
          onBlur={form.leave}
          onKeyDown={enter}
          inputMode="numeric"
          maxLength={3}
          className="w-36"
          data-testid={`${testId}.width`}
        />
        <TextField
          label={tn('repair.print.paperHeight')}
          value={form.height}
          onChange={(event) => {
            onChange();
            form.setHeight(event.target.value);
          }}
          onBlur={form.leave}
          onKeyDown={enter}
          inputMode="numeric"
          maxLength={3}
          className="w-36"
          data-testid={`${testId}.height`}
        />
      </div>
      <p
        className={form.invalid ? 'text-small text-danger' : 'text-small text-text-muted'}
        data-testid={`${testId}.range`}
      >
        {paperRangeHint()}
      </p>
      <Switch
        label={tn('repair.print.paperContinuous')}
        caption={tn('repair.print.paperContinuousHint')}
        checked={form.continuous}
        onChange={(next) => {
          onChange();
          form.setContinuous(next);
        }}
        testId={`${testId}.continuous`}
      />
    </div>
  );
}

function Group({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-small font-semibold text-text">{label}</p>
      {children}
    </div>
  );
}
