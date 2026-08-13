import type { AppServerClient } from "../app-server/appServer";

/**
 * Office and Automation may use the legacy transport only when no Control
 * authority was configured for this renderer. A configured Control session is
 * authoritative even while reconnecting, so returning null is deliberately
 * fail-closed and never becomes a runtime fallback.
 */
export function legacyDomainClientForAuthority(params: {
  controlClientConfigured: boolean;
  legacyClient: AppServerClient | null;
}): AppServerClient | null {
  return params.controlClientConfigured ? null : params.legacyClient;
}
