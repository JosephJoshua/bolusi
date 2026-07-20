// TEST-AUTH seam — the `@bolusi/server/test-support` subpath (task 103). NOT a production API and
// NOT a bypass: it exports the SAME token-verifier the server's own tests already use so an
// out-of-package caller (the chaos harness, @bolusi/harness — the only workspace the boundary rule
// lets value-import @bolusi/server) can make the REAL server emit a genuine wire auth error.
//
// WHY THIS EXISTS. The harness boots the real `createApp` in-process and injects `verifyToken`. For
// the happy path its injected verifier just resolves — but to assert CHAOS-05 T7 (revoked-device
// sync → HTTP `401 DEVICE_REVOKED`, halt drain — api/00 §7, api/02-auth §8, 05-operation-log §8) it
// must make the server RENDER that exact envelope, and only a thrown `ApiError` reaches `onError`
// (app.ts). `ApiError` / `createVerifyToken` / `InMemoryTokenStore` were internal (index.ts exports
// only `routes`/`createApp`/`AppType`), so no test seam could reach the real 401 path.
//
// WHAT THE SEAM IS, AND WHY IT KEEPS PROTOCOL LOGIC IN THE SERVER (testing-guide T-7). It does NOT
// export `ApiError`: a caller that threw `new ApiError('DEVICE_REVOKED')` would be DECIDING the wire
// code itself — protocol logic in the harness. Instead the caller supplies only a token STORE's
// CONTENTS — a device record with `deviceStatus: 'revoked'` (test DATA) — and the REAL
// `createVerifyToken` running inside the middleware maps that record to the genuine
// `ApiError('DEVICE_REVOKED')` that the REAL `onError` renders. The revoked→401 mapping, the
// constant-time hash confirm, the unknown-token→`AUTH_TOKEN_INVALID` and expired-session verdicts
// all stay in the server. The caller injects a verdict's INPUT, never a bypass:
//
//   const store = new InMemoryTokenStore();
//   store.add('bdt_revoked', { kind: 'device', deviceId, tenantId, storeId: null,
//                              deviceStatus: 'revoked' });
//   const app = createApp({ verifyToken: createVerifyToken({ store, now: () => Date.now() }) });
//   // presenting `Bearer bdt_revoked` to any /v1 route → real 401 DEVICE_REVOKED.
//
// Because it is the store, not a code, an active record authenticates normally and an unregistered
// token still `AUTH_TOKEN_INVALID`s — the seam can only inject a REAL verdict, it cannot skip auth.
//
// PRODUCTION IS UNTOUCHED. The default `verifyToken` (deps.ts) is still `createDbVerifyToken` over
// the DB-backed `AuthDirectory`; nothing here changes it. This subpath is test tooling, exactly like
// the internal `test/helpers/app.ts` that already builds `createVerifyToken({ store, now })`.
export {
  createVerifyToken,
  InMemoryTokenStore,
  type TokenRecord,
  type TokenStore,
  type VerifyToken,
} from './middleware/auth.js';
