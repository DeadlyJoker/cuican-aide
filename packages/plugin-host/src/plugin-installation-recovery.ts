import {
  ApplicationError,
  type PluginPreparedSelection,
} from "@crewon/application";
import { parsePluginSelection, type PluginSelection } from "@crewon/domain";
import type { PluginIdentity } from "@crewon/plugin-sdk/node";
import type { LocalPluginInstallationHostDependencies } from "./plugin-installation-local-host.ts";
import type { PluginNodePreparedActivation } from "./plugin-node-host.ts";
import { verifyInstalledSelectionPackage } from "./plugin-installation-package-support.ts";
import { assertPluginUiHostServiceAvailability } from "./plugin-ui-host-service-availability.ts";
import {
  assertRecoveryCurrent,
  orderRecoveries,
  recoveryInput,
  recoveryPolicy,
  recoveryRecord,
  verifyRecovery,
  type PluginInstalledSelectionRecoveryInput,
  type PluginInstalledSelectionRecoveryPolicy,
  type VerifiedRecovery,
} from "./plugin-installation-recovery-support.ts";
export type {
  PluginInstalledSelectionRecoveryInput,
  PluginInstalledSelectionRecoveryPolicy,
} from "./plugin-installation-recovery-support.ts";

export type RecoveryCoordinator = Readonly<{
  dependencies: LocalPluginInstallationHostDependencies;
  lock(): Promise<() => void>;
  trackCleanup(task: Promise<void>): void;
}>;

/** Restores an already confirmed desired selection; this never performs a Store mutation. */
export async function prepareInstalledSelectionRecovery(
  host: RecoveryCoordinator,
  raw: PluginInstalledSelectionRecoveryInput,
  rawPolicy: PluginInstalledSelectionRecoveryPolicy,
): Promise<PluginPreparedSelection> {
  const input = recoveryInput(raw, host.dependencies.profile);
  const policy = recoveryPolicy(rawPolicy);
  const release = await host.lock();
  try {
    const verified = await verifyRecovery(
      input,
      host.dependencies.installRoot,
      policy,
      host.dependencies.hostUiServices,
    );
    return await prepareVerifiedRecovery(host, verified, policy, release);
  } catch (error) {
    release();
    throw error;
  }
}

/**
 * Bounded startup reconciliation. Preflight completes before any entry executes. Setup can execute
 * trusted plugin code; a later failure withdraws only this batch's new publications and awaits cleanup.
 * This coordinates one host/profile, not a distributed owner lease or installer crash-lock recovery.
 */
export async function recoverInstalledSelections(
  host: RecoveryCoordinator,
  raw: readonly PluginInstalledSelectionRecoveryInput[],
  rawPolicy: PluginInstalledSelectionRecoveryPolicy,
): Promise<readonly PluginSelection[]> {
  if (!Array.isArray(raw) || raw.length > 64)
    throw new ApplicationError("validation", "plugin_recovery_batch_invalid");
  const items = Array.from({ length: raw.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value"))
      throw new ApplicationError("validation", "plugin_recovery_batch_invalid");
    return recoveryInput(descriptor.value, host.dependencies.profile);
  });
  if (
    new Set(items.map(({ selection }) => selection.pluginId)).size !==
    items.length
  )
    throw new ApplicationError("validation", "plugin_recovery_batch_invalid");
  const policy = recoveryPolicy(rawPolicy);
  const release = await host.lock();
  const nodeHost = host.dependencies.nodeHost;
  const published: PluginIdentity[] = [];
  try {
    const verified: VerifiedRecovery[] = [];
    for (const input of items) {
      verified.push(
        await verifyRecovery(
          input,
          host.dependencies.installRoot,
          policy,
          host.dependencies.hostUiServices,
        ),
      );
      for (const current of items) assertRecoveryCurrent(current, policy);
    }
    const ordered = orderRecoveries(
      verified,
      nodeHost,
      host.dependencies.hostUiServices,
    );
    for (const record of ordered) {
      for (const current of items) assertRecoveryCurrent(current, policy);
      const previous = acceptingIdentity(host, record.input.selection.pluginId);
      const candidate = await prepareVerifiedRecovery(
        host,
        record,
        policy,
        () => undefined,
      );
      try {
        for (const current of items) assertRecoveryCurrent(current, policy);
        candidate.commit({ selection: record.input.selection });
      } catch (error) {
        await candidate.abort();
        throw error;
      }
      const current = acceptingIdentity(host, record.input.selection.pluginId);
      if (current && current !== previous) published.push(current);
    }
    // UI-only desired state has no accepting Node identity; callbacks cannot substitute a raw publication.
    for (const { input, descriptor } of verified) {
      assertRecoveryCurrent(input, policy);
      const current = acceptingIdentity(host, input.selection.pluginId);
      if (
        input.selection.state === "enabled" && descriptor?.entrypoints.node
          ? current?.packageDigest !== input.selection.selectedPackageDigest
          : current !== undefined
      )
        throw new ApplicationError(
          "conflict",
          "plugin_projection_current_changed",
        );
    }
    return Object.freeze(items.map(({ selection }) => selection));
  } catch (error) {
    for (const identity of published.reverse()) {
      if (acceptingIdentity(host, identity.pluginId) === identity)
        nodeHost.deactivate(identity.pluginId);
    }
    try {
      await nodeHost.drain();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "plugin_recovery_cleanup_failed",
      );
    }
    throw error;
  } finally {
    release();
  }
}

function acceptingIdentity(host: RecoveryCoordinator, pluginId: string) {
  return host.dependencies.nodeHost
    .snapshot()
    .find(
      (instance) =>
        instance.identity.pluginId === pluginId &&
        instance.phase === "accepting",
    )?.identity;
}

async function prepareVerifiedRecovery(
  host: RecoveryCoordinator,
  verified: VerifiedRecovery,
  policy: PluginInstalledSelectionRecoveryPolicy,
  release: () => void,
): Promise<PluginPreparedSelection> {
  const { input } = verified;
  const { selection, package: pkg, actor, scope } = input;
  const uiOnly = verified.descriptor?.entrypoints.node === null;
  const previous = acceptingIdentity(host, selection.pluginId);
  const checkPrevious = () => {
    if (acceptingIdentity(host, selection.pluginId) !== previous)
      throw new ApplicationError(
        "conflict",
        "plugin_projection_current_changed",
      );
  };
  let candidate: PluginNodePreparedActivation | null = null;
  try {
    assertRecoveryCurrent(input, policy);
    if (selection.state === "enabled" && uiOnly) {
      assertPluginUiHostServiceAvailability({
        scope,
        candidate: {
          descriptor: verified.descriptor!,
          packageDigest: pkg!.packageDigest,
        },
        hostUiServices: host.dependencies.hostUiServices,
      });
      const outcome = await host.dependencies.authorizeActivation({
        actor,
        scope,
        candidate: Object.freeze({
          descriptor: verified.descriptor!,
          packageDigest: pkg!.packageDigest,
        }),
      });
      assertRecoveryCurrent(input, policy);
      if (outcome !== "allow")
        throw new ApplicationError("authorization", "plugin_activation_denied");
      await verifyInstalledSelectionPackage({
        installRoot: host.dependencies.installRoot,
        package: pkg!,
        hostUiServices: host.dependencies.hostUiServices,
      });
      assertPluginUiHostServiceAvailability({
        scope,
        candidate: {
          descriptor: verified.descriptor!,
          packageDigest: pkg!.packageDigest,
        },
        hostUiServices: host.dependencies.hostUiServices,
      });
      assertRecoveryCurrent(input, policy);
      checkPrevious();
    } else if (selection.state === "enabled") {
      candidate = await host.dependencies.nodeHost.prepare({
        installRoot: host.dependencies.installRoot,
        expectedPluginId: selection.pluginId,
        expectedPackageDigest: selection.selectedPackageDigest!,
        authorizeActivation: async (value) => {
          assertRecoveryCurrent(input, policy);
          if (
            value.descriptor.publisherId !== selection.publisherId ||
            value.descriptor.version !== pkg!.version ||
            value.packageDigest !== selection.selectedPackageDigest
          )
            return "deny";
          const outcome = await host.dependencies.authorizeActivation({
            actor,
            scope,
            candidate: value,
          });
          assertRecoveryCurrent(input, policy);
          return outcome;
        },
      });
      assertRecoveryCurrent(input, policy);
      checkPrevious();
    }
  } catch (error) {
    await candidate?.abort();
    throw error;
  }
  let phase: "prepared" | "committing" | "committed" | "aborted" = "prepared";
  return Object.freeze({
    abort: async () => {
      if (phase === "committed") return;
      if (phase === "committing")
        throw new ApplicationError("conflict", "plugin_preparation_consumed");
      phase = "aborted";
      try {
        await candidate?.abort();
      } finally {
        release();
      }
    },
    commit: (raw: Readonly<{ selection: PluginSelection }>) => {
      if (phase !== "prepared")
        throw new ApplicationError("conflict", "plugin_preparation_consumed");
      phase = "committing";
      try {
        const requested = parsePluginSelection(
          recoveryRecord(raw, ["selection"]).selection,
        );
        if (JSON.stringify(requested) !== JSON.stringify(selection))
          throw new ApplicationError(
            "conflict",
            "plugin_selection_commit_mismatch",
          );
        assertRecoveryCurrent(input, policy);
        checkPrevious();
        if (selection.state === "enabled" && !uiOnly) {
          candidate!.commit({
            authorizeCommit: (commitCandidate) => {
              assertRecoveryCurrent(input, policy);
              const outcome = host.dependencies.authorizeCommit({
                actor,
                scope,
                selection,
                candidate: commitCandidate,
              });
              assertRecoveryCurrent(input, policy);
              checkPrevious();
              return outcome;
            },
          });
        } else {
          if (selection.state === "enabled" && uiOnly)
            assertPluginUiHostServiceAvailability({
              scope,
              candidate: {
                descriptor: verified.descriptor!,
                packageDigest: pkg!.packageDigest,
              },
              hostUiServices: host.dependencies.hostUiServices,
            });
          const outcome = host.dependencies.authorizeCommit({
            actor,
            scope,
            selection,
            candidate: null,
          });
          assertRecoveryCurrent(input, policy);
          checkPrevious();
          if (outcome !== "allow")
            throw new ApplicationError(
              "authorization",
              "plugin_selection_commit_denied",
            );
          if (selection.state === "enabled" && uiOnly)
            assertPluginUiHostServiceAvailability({
              scope,
              candidate: {
                descriptor: verified.descriptor!,
                packageDigest: pkg!.packageDigest,
              },
              hostUiServices: host.dependencies.hostUiServices,
            });
          host.dependencies.nodeHost.deactivate(selection.pluginId);
        }
        phase = "committed";
      } catch (error) {
        phase = "aborted";
        // Desired state is already durable. Fail closed without withdrawing a re-entrant newer instance.
        if (
          previous &&
          acceptingIdentity(host, selection.pluginId) === previous
        )
          host.dependencies.nodeHost.deactivate(selection.pluginId);
        if (candidate) host.trackCleanup(candidate.abort());
        throw error;
      } finally {
        release();
      }
    },
  });
}
