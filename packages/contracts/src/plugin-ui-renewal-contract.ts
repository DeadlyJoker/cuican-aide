import {
  MAX_PLUGIN_UI_LEASE_RESPONSE_BYTES,
  parsePluginControlMountRef,
} from "./plugin-control-contract.ts";
import {
  copyPluginControlJson,
  pluginControlFail,
  pluginControlRecord,
  pluginControlTimestamp,
} from "./plugin-control-contract-support.ts";
import { parsePluginUiLease, type PluginUiLease } from "./plugin-ui-lease.ts";

export const MAX_PLUGIN_UI_RENEWAL_MS = 5 * 60 * 1000;
export type RenewPluginUiMountRequest = Readonly<{ expectedExpiresAt: string }>;
export type RenewPluginUiMountResponse = PluginUiLease;

export function parseRenewPluginUiMountRequest(
  input: unknown,
): RenewPluginUiMountRequest {
  const fields = pluginControlRecord(input, ["expectedExpiresAt"]);
  return Object.freeze({
    expectedExpiresAt: pluginControlTimestamp(fields.expectedExpiresAt),
  });
}

/** Shape and transition only. A trusted host must still authenticate the current mount owner. */
export function parseRenewPluginUiMountResponse(
  input: unknown,
  expected:
    | PluginUiLease
    | Readonly<{ mountRef: string; expectedExpiresAt: string }>,
): RenewPluginUiMountResponse {
  if (expected === null || typeof expected !== "object") pluginControlFail();
  const fullLease = Object.hasOwn(expected, "schemaVersion")
    ? boundedLease(expected)
    : null;
  const fields = fullLease
    ? { mountRef: fullLease.mountRef, expectedExpiresAt: fullLease.expiresAt }
    : pluginControlRecord(expected, ["mountRef", "expectedExpiresAt"]);
  const mountRef = parsePluginControlMountRef(fields.mountRef);
  const oldExpiry = Date.parse(
    pluginControlTimestamp(fields.expectedExpiresAt),
  );
  const lease = boundedLease(input);
  const newExpiry = Date.parse(lease.expiresAt);
  if (
    lease.mountRef !== mountRef ||
    newExpiry <= oldExpiry ||
    newExpiry > oldExpiry + MAX_PLUGIN_UI_RENEWAL_MS ||
    (fullLease !== null &&
      JSON.stringify({ ...lease, expiresAt: fullLease.expiresAt }) !==
        JSON.stringify(fullLease))
  )
    pluginControlFail("plugin_control_response_context_mismatch");
  return lease;
}

function boundedLease(input: unknown): PluginUiLease {
  return parsePluginUiLease(
    copyPluginControlJson(input, {
      maxBytes: MAX_PLUGIN_UI_LEASE_RESPONSE_BYTES,
      maxNodes: 16384,
    }),
  );
}
