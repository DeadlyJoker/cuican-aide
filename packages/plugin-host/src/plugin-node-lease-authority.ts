import type { PluginIdentity } from "@crewon/plugin-sdk/node";
import type { PluginNodeLease } from "./plugin-node-host.ts";

const leases = new WeakMap<
  object,
  Readonly<{
    identity: PluginIdentity;
    released(): boolean;
    hostClosed(): boolean;
  }>
>();

/** NodeHost-only registration; the SDK and public package entrypoint never expose this. */
export function registerPluginNodeLease(
  lease: PluginNodeLease,
  identity: PluginIdentity,
  released: () => boolean,
  hostClosed: () => boolean,
): void {
  if (leases.has(lease)) throw new Error("plugin_node_lease_conflict");
  leases.set(lease, Object.freeze({ identity, released, hostClosed }));
}

/** A copied lease or identity does not prove possession of a live instance borrow. */
export function pluginNodeLeaseIdentity(
  input: PluginNodeLease,
): PluginIdentity {
  if (input === null || typeof input !== "object")
    throw new Error("plugin_node_lease_invalid");
  const record = leases.get(input);
  if (record === undefined) throw new Error("plugin_node_lease_invalid");
  if (record.released()) throw new Error("plugin_lease_released");
  if (record.hostClosed()) throw new Error("plugin_host_closed");
  return record.identity;
}
