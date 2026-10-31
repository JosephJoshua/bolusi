// The web app's pages by path. The customer's pages need no sign-in; the back-office screens that
// join later get their own routes (and a router, once there is more than a couple of pages). Each
// page loads its own code, so the status page a customer opens from the slip stays small.
import { STATUS_PATH_PREFIX } from '@bolusi/modules/repair/customer-page';
import { lazy, Suspense } from 'react';

import { StatusPage } from './status/StatusPage.js';

const LookupPage = lazy(async () => ({
  default: (await import('./status/LookupPage.js')).LookupPage,
}));

export function App({ path }: { readonly path: string }): React.JSX.Element {
  // The QR and the printed link open /c/<code>; the code is matched in any case, as typed.
  const match = new RegExp(`^${STATUS_PATH_PREFIX}([^/]+)/?$`, 'i').exec(path);
  return (
    <div className="customer-type contents">
      {match !== null ? (
        <StatusPage code={decoded(match[1] ?? '')} />
      ) : (
        <Suspense fallback={null}>
          <LookupPage />
        </Suspense>
      )}
    </div>
  );
}

/** A malformed escape in a hand-typed link is just a code that will not be found. */
function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
