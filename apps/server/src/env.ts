// Hono `Env` for @bolusi/server (api/00 §3, §3.1). Variables are set by the middleware
// chain and read by handlers + onError. `requestId` is set by hono/request-id (§13 step 1);
// `device` / `controlSession` are set by bearerAuth (§3) — exactly one is present on an
// authenticated request, neither on the bearer-exempt POST /v1/auth/login.

/** Device-token principal (api/00 §3): the device, its tenant, and its store (null for system devices). */
export interface DevicePrincipal {
  readonly deviceId: string;
  readonly tenantId: string;
  readonly storeId: string | null;
}

/** Control-session principal (api/00 §3): a user holding the control credential, for the identity surface. */
export interface ControlPrincipal {
  readonly userId: string;
  readonly tenantId: string;
}

export interface AppVariables {
  /** UUIDv7 per request (§5.1); echoed as X-Request-Id and in 500 details. */
  requestId: string;
  /** Set for device-token requests (§3). */
  device: DevicePrincipal;
  /** Set for control-session requests (§3). */
  controlSession: ControlPrincipal;
}

export type AppEnv = { Variables: AppVariables };
