import {
  PluginInstallationError,
  assertPluginSelectionPackage,
  parseInstalledPluginPackage,
  parsePluginSelection,
  pluginInstallationDigest,
  pluginInstallationNamespaceId,
  pluginInstallationNextRevision,
  pluginInstallationTimestamp,
  type InstalledPluginPackage,
  type PluginProfileScope,
  type PluginSelection,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type {
  ApplicationClock,
  ContentDigester,
} from "./application-runtime-ports.ts";
import type { ActorContext } from "./authorization-port.ts";
import type {
  PluginInstallationAuthorizationAction,
  PluginInstallationAuthorizationPort,
} from "./plugin-installation-authorization-port.ts";
import type {
  GetInstalledPluginPackageQuery,
  GetPluginSelectionQuery,
  InstallPluginPackageCommand,
  ListInstalledPluginPackagesQuery,
  ListPluginSelectionsQuery,
  SelectPluginPackageCommand,
  SelectPluginPackageResult,
} from "./plugin-installation-commands.ts";
import type {
  PluginInstallationHostPort,
  PluginInstallationHostProfilePort,
  PluginPreparedSelection,
} from "./plugin-installation-host-port.ts";
import type {
  InstalledPluginPackageResult,
  PluginInstallationStore,
} from "./plugin-installation-store-port.ts";
import {
  checkedInstallationIdentity,
  checkedInstallationPackage,
  checkedInstallationResult,
  checkedInstallationSelection,
  checkedPreparedSelection,
  checkedSelectionResult,
  installationActor,
  installationInput,
  installationInstallCommand,
  installationLimit,
  installationNextCursor,
  installationPage,
  installationProfile,
  installationReceipt,
  installationRecord,
  installationSelectCommand,
  installationStored,
  installationUseCase,
} from "./plugin-installation-application-support.ts";

export type PluginInstallationApplicationDependencies = Readonly<{
  store: PluginInstallationStore;
  profiles: PluginInstallationHostProfilePort;
  authorization: PluginInstallationAuthorizationPort;
  host: PluginInstallationHostPort;
  clock: ApplicationClock;
  digester: ContentDigester;
}>;

/** Authorized durable desired state; no HTTP, Run admission, billing or implicit production adapter. */
export class PluginInstallationApplicationService {
  readonly #dependencies: PluginInstallationApplicationDependencies;
  constructor(dependencies: PluginInstallationApplicationDependencies) {
    this.#dependencies = dependencies;
  }

  install(
    actorInput: ActorContext,
    input: InstallPluginPackageCommand,
  ): Promise<InstalledPluginPackageResult> {
    return installationUseCase(async () => {
      const actor = installationActor(actorInput);
      const command = installationInstallCommand(input);
      const scope = await this.#profile(actor);
      const receipt = installationReceipt(
        actor,
        scope,
        "install",
        command,
        this.#dependencies.digester,
      );
      const authorize = () =>
        this.#authorize(
          actor,
          scope,
          "pluginInstallation:install",
          command.expectedPluginId,
          command.expectedPackageDigest,
        );
      await authorize();
      const saved = await this.#dependencies.store.loadReceipt({
        scope,
        actor,
        kind: "install",
        receipt,
      });
      if (saved !== null) {
        const previous = checkedInstallationResult(
          saved,
          actor,
          scope,
          command,
        );
        await this.#checkSelectedPackage(scope, previous.selection);
        await authorize();
        return Object.freeze({ ...previous, disposition: "replayed" as const });
      }
      const current = await this.#selection(scope, command.expectedPluginId);
      this.#cas(current, command.expectedSelectionRevision);
      if (current !== null) await this.#checkSelectedPackage(scope, current);
      await authorize();
      const installed = await this.#hostCall(() =>
        this.#dependencies.host.install(
          Object.freeze({
            actor,
            scope,
            sourceId: command.sourceId,
            expectedPluginId: command.expectedPluginId,
            expectedPackageDigest: command.expectedPackageDigest,
          }),
        ),
      );
      const identity = checkedInstallationIdentity(installed, command);
      if (current !== null && current.publisherId !== identity.publisherId)
        throw new PluginInstallationError(
          "plugin_installation_publisher_conflict",
        );
      const at = this.#at();
      const pkg = parseInstalledPluginPackage({
        schemaVersion: "crewon.installed-plugin-package.v1",
        ...scope,
        ...identity,
        installedAt: at,
        installedByPrincipalId: actor.principalId,
        installedByActorId: actor.actorId,
      });
      const expected =
        current !== null && current.state !== "uninstalled"
          ? current
          : parsePluginSelection({
              schemaVersion: "crewon.plugin-selection.v1",
              ...scope,
              pluginId: identity.pluginId,
              publisherId: identity.publisherId,
              revision:
                current === null
                  ? 1
                  : pluginInstallationNextRevision(current.revision),
              state: "disabled",
              selectedPackageDigest: identity.packageDigest,
              updatedAt: at,
              updatedByPrincipalId: actor.principalId,
              updatedByActorId: actor.actorId,
            });
      await authorize();
      const raw = await this.#dependencies.store.recordInstalledPackage({
        scope,
        actor,
        package: pkg,
        expectedSelectionRevision: command.expectedSelectionRevision,
        receipt,
      });
      const result = checkedInstallationResult(raw, actor, scope, command, {
        identity,
        selection: expected,
      });
      if (result.disposition === "replayed") {
        await this.#checkSelectedPackage(scope, result.selection);
        await authorize();
      }
      return result;
    });
  }

  select(
    actorInput: ActorContext,
    input: SelectPluginPackageCommand,
  ): Promise<SelectPluginPackageResult> {
    return installationUseCase(async () => {
      const actor = installationActor(actorInput);
      const command = installationSelectCommand(input);
      const scope = await this.#profile(actor);
      const receipt = installationReceipt(
        actor,
        scope,
        "select",
        command,
        this.#dependencies.digester,
      );
      const authorize = () =>
        this.#authorize(
          actor,
          scope,
          "pluginInstallation:select",
          command.pluginId,
          command.selectedPackageDigest,
        );
      await authorize();
      const saved = await this.#dependencies.store.loadReceipt({
        scope,
        actor,
        kind: "select",
        receipt,
      });
      if (saved !== null) {
        const mutation = checkedSelectionResult(saved, actor, scope, command);
        await this.#checkSelectedPackage(scope, mutation.selection);
        await authorize();
        return Object.freeze({
          mutation: Object.freeze({
            ...mutation,
            disposition: "replayed" as const,
          }),
          projection: Object.freeze({ outcome: "unchanged" as const }),
        });
      }
      const current = await this.#selection(scope, command.pluginId);
      this.#cas(current, command.expectedSelectionRevision);
      if (current === null)
        throw new PluginInstallationError(
          "plugin_installation_revision_conflict",
        );
      await this.#checkSelectedPackage(scope, current);
      const pkg =
        command.selectedPackageDigest === null
          ? null
          : await this.#package(scope, command.selectedPackageDigest);
      if (command.selectedPackageDigest !== null && pkg === null)
        throw new PluginInstallationError(
          "plugin_installation_package_not_found",
        );
      if (pkg !== null && pkg.pluginId !== command.pluginId)
        throw new PluginInstallationError(
          "plugin_installation_package_identity_conflict",
        );
      const next = parsePluginSelection({
        ...current,
        revision: pluginInstallationNextRevision(current.revision),
        state: command.state,
        selectedPackageDigest: command.selectedPackageDigest,
        updatedAt: this.#at(),
        updatedByPrincipalId: actor.principalId,
        updatedByActorId: actor.actorId,
      });
      installationStored(() =>
        assertPluginSelectionPackage({ selection: next, package: pkg }),
      );
      await authorize();
      const rawHandle = await this.#hostCall(() =>
        this.#dependencies.host.prepareSelection(
          Object.freeze({
            actor,
            scope,
            currentSelection: current,
            nextSelection: next,
            package: pkg,
          }),
        ),
      );
      let prepared: PluginPreparedSelection;
      try {
        prepared = checkedPreparedSelection(rawHandle);
      } catch (error) {
        await abortInvalidHandle(rawHandle);
        throw error;
      }
      let mutation;
      try {
        await authorize();
        const raw = await this.#dependencies.store.commitSelection({
          scope,
          actor,
          selection: next,
          expectedSelectionRevision: command.expectedSelectionRevision,
          receipt,
        });
        mutation = checkedSelectionResult(raw, actor, scope, command, next);
      } catch (error) {
        await abortPrepared(prepared);
        throw error;
      }
      if (mutation.disposition === "replayed") {
        await abortPrepared(prepared);
        await authorize();
        return Object.freeze({
          mutation,
          projection: Object.freeze({ outcome: "unchanged" as const }),
        });
      }
      try {
        const returned: unknown = prepared.commit(
          Object.freeze({ selection: mutation.selection }),
        );
        if (returned !== undefined) {
          suppressUnexpectedPromise(returned);
          throw new Error("plugin_installation_commit_must_be_synchronous");
        }
        return Object.freeze({
          mutation,
          projection: Object.freeze({ outcome: "applied" as const }),
        });
      } catch {
        // Durable commit already succeeded. Cleanup failure cannot turn it into a claimed rollback.
        await abortPrepared(prepared);
        return Object.freeze({
          mutation,
          projection: Object.freeze({
            outcome: "pending" as const,
            reasonCode: "plugin_projection_pending" as const,
          }),
        });
      }
    });
  }

  getPackage(
    actorInput: ActorContext,
    input: GetInstalledPluginPackageQuery,
  ): Promise<InstalledPluginPackage | null> {
    return installationUseCase(async () => {
      const actor = installationActor(actorInput);
      const packageDigest = installationInput(() =>
        pluginInstallationDigest(
          installationRecord(input, ["packageDigest"]).packageDigest,
        ),
      );
      const scope = await this.#profile(actor);
      await this.#authorize(
        actor,
        scope,
        "pluginInstallation:read",
        null,
        packageDigest,
      );
      const pkg = await this.#package(scope, packageDigest);
      await this.#authorize(
        actor,
        scope,
        "pluginInstallation:read",
        pkg?.pluginId ?? null,
        packageDigest,
      );
      return pkg;
    });
  }

  getSelection(
    actorInput: ActorContext,
    input: GetPluginSelectionQuery,
  ): Promise<PluginSelection | null> {
    return installationUseCase(async () => {
      const actor = installationActor(actorInput);
      const pluginId = installationInput(() =>
        pluginInstallationNamespaceId(
          installationRecord(input, ["pluginId"]).pluginId,
        ),
      );
      const scope = await this.#profile(actor);
      await this.#authorize(
        actor,
        scope,
        "pluginInstallation:read",
        pluginId,
        null,
      );
      const selection = await this.#selection(scope, pluginId);
      if (selection !== null)
        await this.#checkSelectedPackage(scope, selection);
      await this.#authorize(
        actor,
        scope,
        "pluginInstallation:read",
        pluginId,
        selection?.selectedPackageDigest ?? null,
      );
      return selection;
    });
  }

  listPackages(
    actorInput: ActorContext,
    input: ListInstalledPluginPackagesQuery,
  ) {
    return installationUseCase(async () => {
      const actor = installationActor(actorInput);
      const query = installationInput(() => {
        const value = installationRecord(input, [
          "pluginId",
          "afterPackageDigest",
          "limit",
        ]);
        return Object.freeze({
          pluginId:
            value.pluginId === null
              ? null
              : pluginInstallationNamespaceId(value.pluginId),
          afterPackageDigest:
            value.afterPackageDigest === null
              ? null
              : pluginInstallationDigest(value.afterPackageDigest),
          limit: installationLimit(value.limit),
        });
      });
      const scope = await this.#profile(actor);
      await this.#authorize(
        actor,
        scope,
        "pluginInstallation:read",
        query.pluginId,
        null,
      );
      const raw = await this.#dependencies.store.listPackages({
        scope,
        ...query,
      });
      const page = installationStored(() =>
        installationRecord(raw, ["packages", "next"]),
      );
      const packages = installationPage(
        page.packages,
        query.limit,
        (item) => {
          const pkg = installationStored(() =>
            parseInstalledPluginPackage(item),
          );
          return checkedInstallationPackage(pkg, scope, {
            packageDigest: pkg.packageDigest,
            pluginId: query.pluginId ?? undefined,
          });
        },
        (pkg) => pkg.packageDigest,
        query.afterPackageDigest,
      );
      const next = installationNextCursor(
        page.next,
        packages.map((pkg) => pkg.packageDigest),
        query.limit,
      );
      await this.#authorize(
        actor,
        scope,
        "pluginInstallation:read",
        query.pluginId,
        null,
      );
      return Object.freeze({ packages, next });
    });
  }

  listSelections(actorInput: ActorContext, input: ListPluginSelectionsQuery) {
    return installationUseCase(async () => {
      const actor = installationActor(actorInput);
      const query = installationInput(() => {
        const value = installationRecord(input, ["afterPluginId", "limit"]);
        return Object.freeze({
          afterPluginId:
            value.afterPluginId === null
              ? null
              : pluginInstallationNamespaceId(value.afterPluginId),
          limit: installationLimit(value.limit),
        });
      });
      const scope = await this.#profile(actor);
      await this.#authorize(
        actor,
        scope,
        "pluginInstallation:read",
        null,
        null,
      );
      const raw = await this.#dependencies.store.listSelections({
        scope,
        ...query,
      });
      const page = installationStored(() =>
        installationRecord(raw, ["selections", "next"]),
      );
      const selections = installationPage(
        page.selections,
        query.limit,
        (item) => {
          const parsed = installationStored(() => parsePluginSelection(item));
          return checkedInstallationSelection(parsed, scope, parsed.pluginId);
        },
        (selection) => selection.pluginId,
        query.afterPluginId,
      );
      for (const selection of selections)
        await this.#checkSelectedPackage(scope, selection);
      const next = installationNextCursor(
        page.next,
        selections.map((selection) => selection.pluginId),
        query.limit,
      );
      await this.#authorize(
        actor,
        scope,
        "pluginInstallation:read",
        null,
        null,
      );
      return Object.freeze({ selections, next });
    });
  }

  async #profile(actor: ActorContext): Promise<PluginProfileScope> {
    let raw;
    try {
      raw = await this.#dependencies.profiles.resolve(actor);
    } catch (error) {
      throw new ApplicationError(
        "internal",
        "plugin_installation_profile_unavailable",
        { cause: error },
      );
    }
    return installationProfile(raw, actor);
  }
  async #authorize(
    actor: ActorContext,
    scope: PluginProfileScope,
    action: PluginInstallationAuthorizationAction,
    pluginId: string | null,
    packageDigest: string | null,
  ): Promise<void> {
    const current = await this.#profile(actor);
    if (current.profileId !== scope.profileId)
      throw new ApplicationError(
        "authorization",
        "plugin_installation_profile_changed",
      );
    try {
      const decision = await this.#dependencies.authorization.authorize(
        Object.freeze({
          actor,
          action,
          resource: Object.freeze({
            kind: "pluginInstallation" as const,
            ...scope,
            pluginId,
            packageDigest,
          }),
        }),
      );
      const outcome =
        decision !== null && typeof decision === "object"
          ? Object.getOwnPropertyDescriptor(decision, "outcome")
          : undefined;
      if (!outcome || !Object.hasOwn(outcome, "value"))
        throw new Error("authorization_invalid");
      const fields =
        outcome.value === "allow" ? ["outcome"] : ["outcome", "reasonCode"];
      const value = installationRecord(decision, fields);
      if (value.outcome === "deny" && typeof value.reasonCode === "string")
        throw new ApplicationError("authorization", "authorization_denied");
      if (value.outcome !== "allow") throw new Error("authorization_invalid");
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError("authorization", "authorization_unavailable", {
        cause: error,
      });
    }
  }
  async #package(
    scope: PluginProfileScope,
    packageDigest: string,
  ): Promise<InstalledPluginPackage | null> {
    const raw = await this.#dependencies.store.loadPackage({
      scope,
      packageDigest,
    });
    return raw === null
      ? null
      : checkedInstallationPackage(raw, scope, { packageDigest });
  }
  async #selection(
    scope: PluginProfileScope,
    pluginId: string,
  ): Promise<PluginSelection | null> {
    const raw = await this.#dependencies.store.loadSelection({
      scope,
      pluginId,
    });
    return raw === null
      ? null
      : checkedInstallationSelection(raw, scope, pluginId);
  }
  async #checkSelectedPackage(
    scope: PluginProfileScope,
    selection: PluginSelection,
  ): Promise<void> {
    const pkg =
      selection.selectedPackageDigest === null
        ? null
        : await this.#package(scope, selection.selectedPackageDigest);
    installationStored(() =>
      assertPluginSelectionPackage({ selection, package: pkg }),
    );
  }
  #cas(current: PluginSelection | null, expected: number | null): void {
    if ((current?.revision ?? null) !== expected)
      throw new PluginInstallationError(
        "plugin_installation_revision_conflict",
      );
  }
  #at(): string {
    try {
      return pluginInstallationTimestamp(this.#dependencies.clock.now());
    } catch (error) {
      throw new ApplicationError(
        "internal",
        "plugin_installation_clock_invalid",
        { cause: error },
      );
    }
  }
  async #hostCall<T>(execute: () => Promise<T>): Promise<T> {
    try {
      return await execute();
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError(
        "internal",
        "plugin_installation_host_unavailable",
        { cause: error },
      );
    }
  }
}

async function abortPrepared(prepared: PluginPreparedSelection): Promise<void> {
  try {
    await prepared.abort();
  } catch {
    /* Host retains cleanup diagnostics; never hide a durable commit or the primary failure. */
  }
}
async function abortInvalidHandle(input: unknown): Promise<void> {
  if (input === null || typeof input !== "object") return;
  const descriptor = Object.getOwnPropertyDescriptor(input, "abort");
  if (
    descriptor &&
    Object.hasOwn(descriptor, "value") &&
    descriptor.enumerable &&
    typeof descriptor.value === "function"
  ) {
    try {
      await descriptor.value.call(input);
    } catch {
      /* Preserve the malformed-host-result failure. */
    }
  }
}
function suppressUnexpectedPromise(input: unknown): void {
  if (input === null || typeof input !== "object") return;
  try {
    void Promise.prototype.then.call(input, undefined, () => undefined);
  } catch {
    /* Non-Promise return still marks publication pending. */
  }
}
