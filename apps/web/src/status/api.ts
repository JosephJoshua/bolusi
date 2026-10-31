// Reads a servisan's status from the server that serves this page. The answer's shape is the
// server's contract (@bolusi/schemas PublicRepairStatus); it is not re-validated here, to keep zod
// out of a page customers load over mobile data.
import type { PublicRepairStatus } from '@bolusi/schemas';

export type StatusResult =
  | { readonly kind: 'found'; readonly status: PublicRepairStatus }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'ended' }
  /** No connection, a server fault or an answer this page cannot read: worth trying again. */
  | { readonly kind: 'failed' };

export async function fetchStatus(
  code: string,
  fetcher: typeof fetch = fetch,
): Promise<StatusResult> {
  try {
    const res = await fetcher(`/v1/public/status/${encodeURIComponent(code)}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (res.status === 404) {
      const body = (await res.json().catch(() => null)) as {
        error?: { details?: { reason?: string } };
      } | null;
      return body?.error?.details?.reason === 'ended' ? { kind: 'ended' } : { kind: 'notFound' };
    }
    if (!res.ok) return { kind: 'failed' };
    const status = (await res.json()) as PublicRepairStatus;
    return typeof status.status === 'string' && Array.isArray(status.steps)
      ? { kind: 'found', status }
      : { kind: 'failed' };
  } catch {
    return { kind: 'failed' };
  }
}
