import type {
  ActorContext,
  PluginPreparedSelection,
  PluginInstallationPrepareSelectionInput,
} from "@crewon/application";
import type {
  InstalledPluginPackage,
  PluginProfileScope,
  PluginSelection,
} from "@crewon/domain";
import type { PluginPackageDescriptor } from "@crewon/contracts/plugins";
import type { SqlitePluginInstallationProfileOwner } from "@crewon/store";
import type {
  LocalPluginInstallationHost,
  PluginCompositionCoordinator,
  PluginNodeCommitCandidate,
  PluginUiHostServiceAvailabilityPort,
} from "@crewon/plugin-host";
import {
  orderInstallationRecoveries,
  type InstallationRecoveryRecord,
} from "./production-plugin-installation-runtime-support.ts";

/** Original profile recovery policy; the Profile retains its operation, queue, claim and publication stamp. */
export async function recoverDesktopPluginProfile(
  input: Readonly<{
    actor: ActorContext;
    owner: SqlitePluginInstallationProfileOwner;
    nodes: PluginCompositionCoordinator;
    local: LocalPluginInstallationHost;
    hostUiServices?: PluginUiHostServiceAvailabilityPort;
    bindOperation(scope: PluginProfileScope, epoch: string | null): unknown;
    isCurrent(operation: unknown): boolean;
    confirmed(selection: PluginSelection): boolean;
    refresh(
      selection: PluginSelection,
      scope: PluginProfileScope,
    ): Promise<string>;
    verify(pkg: InstalledPluginPackage): Promise<PluginPackageDescriptor>;
    wrap(
      handle: PluginPreparedSelection,
      selection: Pick<
        PluginInstallationPrepareSelectionInput,
        "actor" | "scope" | "nextSelection"
      >,
    ): PluginPreparedSelection;
  }>,
): Promise<void> {
  const snapshot = input.owner.snapshot();
  const records: InstallationRecoveryRecord[] = [];
  for (const selection of snapshot.selections) {
    input.bindOperation(snapshot.scope, null);
    const epoch = await input.refresh(selection, snapshot.scope);
    const pkg = input.owner.currentSelectedPackage({
      scope: snapshot.scope,
      pluginId: selection.pluginId,
    });
    const descriptor = pkg === null ? null : await input.verify(pkg);
    records.push(Object.freeze({ selection, package: pkg, descriptor, epoch }));
  }
  const published: PluginNodeCommitCandidate["identity"][] = [];
  try {
    for (const record of orderInstallationRecoveries(
      records,
      input.nodes,
      input.hostUiServices,
    )) {
      const operation = input.bindOperation(snapshot.scope, record.epoch);
      const handle = await input.local.prepareRecovery(
        {
          actor: input.actor,
          scope: snapshot.scope,
          selection: record.selection,
          package: record.package,
        },
        {
          authorizeCurrent: ({ selection }) =>
            input.isCurrent(operation) && input.confirmed(selection)
              ? "allow"
              : "deny",
          validateCompatibility: async () => {
            if (record.package !== null) await input.verify(record.package);
          },
        },
      );
      const wrapped = input.wrap(handle, {
        actor: input.actor,
        scope: snapshot.scope,
        nextSelection: record.selection,
      });
      try {
        await wrapped.prepareCommit!({ selection: record.selection });
        wrapped.commit({ selection: record.selection });
        const current = input.nodes
          .snapshot()
          .find(
            (value) =>
              value.phase === "accepting" &&
              value.identity.pluginId === record.selection.pluginId,
          );
        if (current !== undefined) published.push(current.identity);
      } catch (error) {
        await wrapped.abort();
        throw error;
      }
    }
  } catch (error) {
    for (const identity of published.reverse())
      if (
        input.nodes
          .snapshot()
          .some(
            (value) =>
              value.identity === identity && value.phase === "accepting",
          )
      )
        input.nodes.revoke(identity.pluginId);
    await input.nodes.drain();
    throw error;
  }
}
