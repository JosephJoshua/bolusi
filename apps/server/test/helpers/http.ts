// Typed readers over Response bodies. undici's Response.json() returns `unknown`; these give the
// error-envelope shape a name so tests read `.error.code` without `any` (which the lint config
// forbids) and without re-parsing at every call site.

export interface ErrorDetails {
  limitBytes: number;
  retryAfterSeconds: number;
  requestId: string;
  issues: unknown[];
  [key: string]: unknown;
}

export interface ErrorBody {
  error: { code: string; message: string; details: ErrorDetails };
}

/** Read a §6 error envelope. The caller asserts which details fields are present for its status. */
export async function readError(res: Response): Promise<ErrorBody> {
  return (await res.json()) as ErrorBody;
}
