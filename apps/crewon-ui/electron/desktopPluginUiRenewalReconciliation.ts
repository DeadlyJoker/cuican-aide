import {
  parsePluginUiLease,
  parseRenewPluginUiMountResponse,
  type PluginUiLease,
} from "@crewon/contracts/plugins";

/** An old snapshot is safe only when no renewal CAS has been dispatched. */
export function reconcileNativePluginUiRenewal(
  input: Readonly<{
    bytes: Uint8Array;
    contentType: string | null;
    original: PluginUiLease;
    identity: string;
    renewalDispatched: boolean;
  }>,
): PluginUiLease | null {
  if (!/^application\/json(?:; charset=utf-8)?$/u.test(input.contentType ?? ""))
    throw new Error("desktop_plugin_ui_lease_response_invalid");
  const current = parsePluginUiLease(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.bytes)),
  );
  if (JSON.stringify(current) === JSON.stringify(input.original)) {
    if (input.identity !== JSON.stringify(input.original))
      throw new Error("desktop_plugin_ui_lease_changed");
    // The server can finish a dispatched CAS after this old GET snapshot.
    if (input.renewalDispatched)
      throw new Error("desktop_plugin_ui_renewal_outcome_unknown");
    return null;
  }
  return parseRenewPluginUiMountResponse(current, input.original);
}
