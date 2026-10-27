import { LoaderCircle } from 'lucide-react';

/** A small busy indicator for a control whose action is running. */
export function Spinner({ size = 16 }: { readonly size?: number }): React.JSX.Element {
  return <LoaderCircle size={size} className="animate-spin" aria-hidden />;
}
