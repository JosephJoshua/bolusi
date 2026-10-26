// Form fields: a label above the control, an optional hint, and the problem in place of the hint
// once there is one. The label is the field's accessible name; placeholders are examples only.
import { clsx } from 'clsx';
import { Eye, EyeOff } from 'lucide-react';
import {
  forwardRef,
  useId,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';

interface FieldFrameProps {
  readonly label: string;
  readonly hint?: string | undefined;
  readonly error?: string | undefined;
  /** Beside the label, such as "Opsional" or a text button. */
  readonly labelAside?: ReactNode;
  readonly className?: string | undefined;
}

export function FieldFrame({
  id,
  label,
  hint,
  error,
  labelAside,
  className,
  children,
}: FieldFrameProps & { readonly id: string; readonly children: ReactNode }): React.JSX.Element {
  return (
    <div className={clsx('flex flex-col gap-1', className)}>
      <div className="flex min-h-6 items-center justify-between gap-2">
        <label htmlFor={id} className="text-small font-semibold text-text">
          {label}
        </label>
        {labelAside}
      </div>
      {children}
      {error === undefined ? (
        hint === undefined ? null : (
          <p id={`${id}-hint`} className="text-small text-text-muted">
            {hint}
          </p>
        )
      ) : (
        <p id={`${id}-hint`} role="alert" className="text-small text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export const controlClass = (invalid: boolean): string =>
  clsx(
    'w-full rounded-sm border bg-surface px-3 text-body text-text placeholder:text-text-disabled transition-colors',
    'focus:outline-none focus:ring-2 focus:ring-primary/25',
    'disabled:bg-surface-alt disabled:text-text-muted',
    invalid ? 'border-danger focus:border-danger' : 'border-border focus:border-primary',
  );

export interface TextFieldProps
  extends FieldFrameProps, Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> {
  /** Shown inside the field before the value, such as "Rp". */
  readonly prefix?: string | undefined;
  readonly inputClassName?: string | undefined;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, hint, error, labelAside, className, prefix, inputClassName, id: idProp, ...rest },
  ref,
) {
  const generated = useId();
  const id = idProp ?? generated;
  const input = (
    <input
      ref={ref}
      id={id}
      aria-invalid={error !== undefined || undefined}
      aria-describedby={error !== undefined || hint !== undefined ? `${id}-hint` : undefined}
      className={clsx(
        controlClass(error !== undefined),
        'h-10',
        prefix !== undefined && 'pl-10',
        inputClassName,
      )}
      {...rest}
    />
  );
  return (
    <FieldFrame
      id={id}
      label={label}
      hint={hint}
      error={error}
      labelAside={labelAside}
      className={className}
    >
      {prefix === undefined ? (
        input
      ) : (
        <div className="relative">
          <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-body text-text-muted">
            {prefix}
          </span>
          {input}
        </div>
      )}
    </FieldFrame>
  );
});

export interface TextAreaProps
  extends FieldFrameProps, Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'> {}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { label, hint, error, labelAside, className, id: idProp, rows = 3, ...rest },
  ref,
) {
  const generated = useId();
  const id = idProp ?? generated;
  return (
    <FieldFrame
      id={id}
      label={label}
      hint={hint}
      error={error}
      labelAside={labelAside}
      className={className}
    >
      <textarea
        ref={ref}
        id={id}
        rows={rows}
        aria-invalid={error !== undefined || undefined}
        aria-describedby={error !== undefined || hint !== undefined ? `${id}-hint` : undefined}
        className={clsx(controlClass(error !== undefined), 'resize-y py-2')}
        {...rest}
      />
    </FieldFrame>
  );
});

export interface SecretFieldProps extends Omit<TextFieldProps, 'type' | 'prefix'> {
  readonly showLabel: string;
  readonly hideLabel: string;
}

/** A value typed hidden so it is not read over the counter, with an eye to check it. */
export const SecretField = forwardRef<HTMLInputElement, SecretFieldProps>(function SecretField(
  { showLabel, hideLabel, label, hint, error, labelAside, className, id: idProp, ...rest },
  ref,
) {
  const generated = useId();
  const id = idProp ?? generated;
  const [shown, setShown] = useState(false);
  return (
    <FieldFrame
      id={id}
      label={label}
      hint={hint}
      error={error}
      labelAside={labelAside}
      className={className}
    >
      <div className="relative">
        <input
          ref={ref}
          id={id}
          type={shown ? 'text' : 'password'}
          autoComplete="off"
          aria-invalid={error !== undefined || undefined}
          className={clsx(controlClass(error !== undefined), 'h-10 pr-11')}
          {...rest}
        />
        <button
          type="button"
          aria-label={shown ? hideLabel : showLabel}
          aria-pressed={shown}
          onClick={() => setShown((value) => !value)}
          className="absolute inset-y-0 right-1 my-auto flex size-8 cursor-pointer items-center justify-center rounded-sm text-text-muted hover:bg-surface-alt hover:text-text"
        >
          {shown ? <EyeOff size={18} aria-hidden /> : <Eye size={18} aria-hidden />}
        </button>
      </div>
    </FieldFrame>
  );
});
