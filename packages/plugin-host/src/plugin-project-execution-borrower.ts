import type { PluginUiActionContext } from "@crewon/application";
import type { PluginTaskAdmissionPin } from "@crewon/domain";
import type { PluginIdentity } from "@crewon/plugin-sdk/node";
import type { PluginNodeHost, PluginNodeLease } from "./plugin-node-host.ts";
import { pluginNodeLeaseIdentity } from "./plugin-node-lease-authority.ts";
import {
  bridgeFailure,
  bridgeFields,
} from "./plugin-task-action-bridge-support.ts";

/** Host-only target borrow. The original source UI invocation remains separately authorized. */
export type PluginProjectExecutionBorrower = Readonly<{
  borrow(
    input: Readonly<{
      context: PluginUiActionContext;
      executionPin: PluginTaskAdmissionPin;
      authorizeBorrow(identity: PluginIdentity): "allow" | "deny";
    }>,
  ): Readonly<{ lease: PluginNodeLease; release(): void }>;
}>;
type Access = Readonly<{
  acquire: PluginNodeHost["acquire"];
  release(lease: PluginNodeLease): void;
  assertCurrent?(identity: PluginIdentity): void;
}>;
export type ProjectExecutionLeaseSource = Readonly<{
  prepare(context: PluginUiActionContext, pin: PluginTaskAdmissionPin): Access;
}>;

export function projectExecutionHostAccess(
  host: PluginNodeHost,
): ProjectExecutionLeaseSource {
  return {
    prepare: () => ({
      acquire: (options) => host.acquire(options),
      release: (lease) => lease.release(),
    }),
  };
}

/** Captures only a trusted owner callback; each returned lease must still prove actual Host issuance. */
export function projectExecutionBorrowerAccess(
  input: PluginProjectExecutionBorrower,
): ProjectExecutionLeaseSource {
  const fields = bridgeFields(input, ["borrow"]);
  if (typeof fields.borrow !== "function")
    bridgeFailure("plugin_project_execution_borrower_invalid");
  const borrow = fields.borrow.bind(
    input,
  ) as PluginProjectExecutionBorrower["borrow"];
  return {
    prepare(context, pin) {
      const releases = new WeakMap<PluginNodeLease, () => void>();
      const matches = (identity: PluginIdentity) =>
        identity.pluginId === pin.pluginId &&
        identity.version === pin.version &&
        identity.packageDigest === pin.packageDigest;
      const acquire: Access["acquire"] = (options) => {
        if (
          options.pluginId !== pin.pluginId ||
          options.packageDigest !== pin.packageDigest ||
          options.purpose !== "newOperation"
        )
          bridgeFailure("plugin_project_execution_borrower_invalid");
        const handle = borrow(
          Object.freeze({
            context,
            executionPin: pin,
            authorizeBorrow: options.authorizeBorrow,
          }),
        );
        const releaseField =
          handle && typeof handle === "object"
            ? Object.getOwnPropertyDescriptor(handle, "release")
            : undefined;
        if (
          !releaseField ||
          !Object.hasOwn(releaseField, "value") ||
          typeof releaseField.value !== "function"
        )
          bridgeFailure("plugin_project_execution_borrower_invalid");
        const cleanup = releaseField.value.bind(handle) as () => void;
        try {
          const captured = bridgeFields(handle, ["lease", "release"]);
          const lease = captured.lease as PluginNodeLease;
          const identity = pluginNodeLeaseIdentity(lease);
          if (
            lease.identity !== identity ||
            releases.has(lease) ||
            !matches(identity) ||
            options.authorizeBorrow(identity) !== "allow"
          )
            bridgeFailure("plugin_project_execution_borrower_invalid");
          releases.set(lease, cleanup);
          return lease;
        } catch (error) {
          cleanup();
          throw error;
        }
      };
      const release = (lease: PluginNodeLease) => {
        const cleanup = releases.get(lease);
        if (!cleanup)
          bridgeFailure("plugin_project_execution_borrower_invalid");
        releases.delete(lease);
        cleanup();
      };
      return {
        acquire,
        release,
        assertCurrent(identity) {
          const current = acquire({
            pluginId: pin.pluginId,
            packageDigest: pin.packageDigest,
            purpose: "newOperation",
            authorizeBorrow: (next) =>
              matches(next) && next === identity ? "allow" : "deny",
          });
          try {
            if (current.identity !== identity)
              bridgeFailure("plugin_project_execution_instance_changed");
          } finally {
            release(current);
          }
        },
      };
    },
  };
}
