// Pieces every desktop repair screen shares: the status chip, a verified photo's state, the
// banners for a refused action or a step overtaken by a change from elsewhere, and money entry.
import { formatNumber, t, translateErrorCode, translateFailure } from '@bolusi/i18n';
import {
  Banner,
  Chip,
  Fact,
  FactGrid,
  Section,
  StatePanel,
  TextField,
  type PhotoLabels,
  type PhotoState,
  type TextFieldProps,
} from '@bolusi/ui-web';
import {
  Ban,
  CircleCheck,
  FileQuestion,
  Hourglass,
  Inbox,
  LoaderCircle,
  Lock,
  PackageCheck,
  Smartphone,
  TriangleAlert,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useState, type ReactNode } from 'react';

import type { QueryState, ThumbnailRef } from '../../screen-kit/index.js';
import {
  acceptsRupiahText,
  parseRupiah,
  statusTone,
  type StaleStep,
  type TicketStatus,
} from '../flows.js';
import { tn, type RepairKey } from '../i18n.js';
import { SPEC_FACT_KEY, staleStepMessage, statusLabel } from '../labels.js';
import { specFacts } from '../device-specs.js';
import type { DeviceModelPhoto } from '../device-models.js';
import { useCatalogModel } from '../model-picker.js';
import {
  PrinterProblem,
  useModelPhoto,
  useRepairThumbnail,
  type PrinterProblemReason,
} from '../runtime.js';

const STATUS_ICON: Readonly<Record<TicketStatus, LucideIcon>> = {
  received: Inbox,
  in_repair: Wrench,
  waiting_for_parts: Hourglass,
  repaired: CircleCheck,
  cancelled: Ban,
  returned: PackageCheck,
};

export function StatusChip({ status }: { readonly status: TicketStatus }): React.JSX.Element {
  return <Chip label={statusLabel(status)} icon={STATUS_ICON[status]} tone={statusTone(status)} />;
}

export const WarningIcon = TriangleAlert;

/** A photo resolved through the media client, in the shape the photo components take. */
export function usePhotoState(ref: ThumbnailRef | null): PhotoState {
  return useRepairThumbnail(ref);
}

export function photoLabels(): PhotoLabels {
  return {
    unavailable: tn('repair.desk.photoUnavailable'),
    mismatch: tn('repair.desk.photoMismatch'),
  };
}

/** A refused action, in the dialog or pane it came from. */
export function ActionError({
  errorCode,
  onDismiss,
}: {
  readonly errorCode: string | null;
  readonly onDismiss: () => void;
}): React.JSX.Element | null {
  if (errorCode === null) return null;
  return (
    <Banner
      tone="danger"
      message={translateFailure(errorCode)}
      onDismiss={onDismiss}
      dismissLabel={t('core.action.close')}
    />
  );
}

/**
 * Why the last print did not reach the printer, kept apart from other failures so the screen can
 * say what to check. `catchProblem` wraps a print: a `PrinterProblem` becomes the reason here and
 * the print reads as not done.
 */
export function usePrinterProblem(): readonly [
  PrinterProblemReason | null,
  <T>(print: Promise<T>) => Promise<T | 'cancelled'>,
  () => void,
] {
  const [problem, setProblem] = useState<PrinterProblemReason | null>(null);
  const catchProblem = useCallback(async <T,>(print: Promise<T>): Promise<T | 'cancelled'> => {
    setProblem(null);
    try {
      return await print;
    } catch (error) {
      if (!(error instanceof PrinterProblem)) throw error;
      setProblem(error.reason);
      return 'cancelled';
    }
  }, []);
  const clear = useCallback(() => setProblem(null), []);
  return [problem, catchProblem, clear];
}

const PRINTER_PROBLEM_KEY: Readonly<Record<PrinterProblemReason, RepairKey>> = {
  noPrinter: 'repair.print.problem.noPrinter',
  printerMissing: 'repair.print.problem.printerMissing',
  failed: 'repair.print.problem.failed',
};

export function PrinterProblemBanner({
  problem,
  onDismiss,
}: {
  readonly problem: PrinterProblemReason | null;
  /** Absent for a problem that stays until it is fixed (no printer picked). */
  readonly onDismiss?: (() => void) | undefined;
}): React.JSX.Element | null {
  if (problem === null) return null;
  return (
    <Banner
      tone="danger"
      message={tn(PRINTER_PROBLEM_KEY[problem])}
      onDismiss={onDismiss}
      dismissLabel={onDismiss === undefined ? undefined : t('core.action.close')}
    />
  );
}

/** A step the ticket can no longer finish because it changed on another device. */
export function StaleNotice({
  stale,
}: {
  readonly stale: StaleStep | null;
}): React.JSX.Element | null {
  return stale === null ? null : <Banner tone="warning" message={staleStepMessage(stale)} />;
}

/** A read's loading, no-access, missing and error states; `ready` renders through `children`. */
export function QueryPanel<TData>({
  query,
  onRetry,
  children,
}: {
  readonly query: QueryState<TData>;
  readonly onRetry: () => void;
  readonly children: (data: TData) => ReactNode;
}): React.JSX.Element {
  switch (query.status) {
    case 'loading':
      return (
        <div className="flex justify-center py-12 text-text-muted">
          <LoaderCircle size={24} className="animate-spin" aria-label={t('core.status.loading')} />
        </div>
      );
    case 'unauthorized':
      return (
        <StatePanel
          icon={Lock}
          title={t('core.errors.PERMISSION_DENIED')}
          hint={t('core.unauthorized.askOwner')}
        />
      );
    case 'error':
      return (
        <StatePanel
          icon={FileQuestion}
          tone="danger"
          title={translateErrorCode(query.code)}
          action={
            <button
              type="button"
              onClick={onRetry}
              className="cursor-pointer text-body font-semibold text-primary hover:underline"
            >
              {t('core.action.retry')}
            </button>
          }
        />
      );
    case 'ready':
      return <>{children(query.data)}</>;
  }
}

/** "650.000" for 650000 and nothing for 0, so an amount reads as the customer hears it. */
export function rupiahText(amount: number | null): string {
  return amount === null || amount === 0 ? '' : formatNumber(amount);
}

/** An amount in whole rupiah, grouped as it is typed; refuses keystrokes past the line limit. */
export function MoneyField({
  value,
  onChange,
  ...rest
}: Omit<TextFieldProps, 'value' | 'onChange' | 'prefix' | 'inputMode'> & {
  readonly value: number | null;
  readonly onChange: (value: number | null) => void;
}): React.JSX.Element {
  return (
    <TextField
      {...rest}
      prefix={tn('repair.desk.currency')}
      inputMode="numeric"
      inputClassName="tabular text-right"
      // Empty only when nothing is typed: a fee of 0 (waived) must read as 0.
      value={value === null ? '' : formatNumber(value)}
      onChange={(event) => {
        const text = event.target.value;
        if (acceptsRupiahText(text)) onChange(parseRupiah(text));
      }}
    />
  );
}

/**
 * A catalog picture of a phone model, the whole phone shown uncropped. While it loads, or when
 * there is none (offline, not in the catalog), a plain phone glyph holds its place.
 */
export function ModelPhoto({
  photo,
  large = false,
}: {
  readonly photo: DeviceModelPhoto | null;
  readonly large?: boolean;
}): React.JSX.Element {
  const uri = useModelPhoto(photo);
  const frame = large ? 'h-20 w-16' : 'h-10 w-8';
  return uri === null ? (
    <span
      aria-hidden
      className={`${frame} flex shrink-0 items-center justify-center rounded-xs bg-surface-alt text-text-muted`}
    >
      <Smartphone size={large ? 24 : 16} />
    </span>
  ) : (
    <img src={uri} alt="" className={`${frame} shrink-0 object-contain`} />
  );
}

/** The catalog picture of a ticket's phone, or nothing when the catalog has no picture of it. */
export function CatalogPhoto({
  brand,
  model,
}: {
  readonly brand: string;
  readonly model: string;
}): React.JSX.Element | null {
  const found = useCatalogModel(brand, model);
  const uri = useModelPhoto(found?.photo ?? null);
  if (uri === null) return null;
  return (
    <img
      src={uri}
      alt=""
      className="h-20 w-16 shrink-0 object-contain"
      data-testid="repair.desk.ticket.devicePhoto"
    />
  );
}

/**
 * The catalog's specs for a ticket's phone, as the viewer needs them (`specFacts`): memory
 * variants for everyone, the inside of the phone for someone who repairs it. Nothing when the
 * catalog does not know the model or has no specs for it.
 */
export function DeviceSpecs({
  brand,
  model,
  repairs,
}: {
  readonly brand: string;
  readonly model: string;
  readonly repairs: boolean;
}): React.JSX.Element | null {
  const found = useCatalogModel(brand, model);
  const facts = found === null ? [] : specFacts(found.specs, repairs);
  if (facts.length === 0) return null;
  return (
    <Section title={tn('repair.spec.title')} testId="repair.desk.ticket.specs">
      <FactGrid>
        {facts.map((fact) => (
          <Fact
            key={fact.key}
            label={tn(SPEC_FACT_KEY[fact.key])}
            // GSMArena's "No" for a phone without a card slot.
            value={fact.value === 'No' ? tn('repair.spec.none') : fact.value}
            testId={`repair.desk.ticket.specs.${fact.key}`}
          />
        ))}
      </FactGrid>
    </Section>
  );
}
