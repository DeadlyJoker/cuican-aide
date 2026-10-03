import {
  parsePluginPackageDescriptor,
  parsePluginUiJsonValue,
  type PluginUiLease,
} from "@crewon/contracts/plugins";
import type { PluginProfileScope } from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import { registerPluginUiInvocation } from "./plugin-ui-invocation-authority.ts";
import type { ApplicationClock } from "./application-runtime-ports.ts";
import type { ActorContext } from "./authorization-port.ts";
import type { PluginInstallationHostProfilePort } from "./plugin-installation-host-port.ts";
import type { PluginInstallationStore } from "./plugin-installation-store-port.ts";
import type {
  InvokePluginUiActionCommand,
  OpenPluginUiMountCommand,
  PluginUiCatalog,
  PluginUiCatalogItem,
  PluginUiCatalogQuery,
  PluginUiMountQuery,
  ReadPluginUiAssetQuery,
} from "./plugin-ui-commands.ts";
import type {
  PluginUiActionPort,
  PluginUiActionContext,
  PluginUiCommittedTaskPort,
  PluginUiCommittedMetadataPort,
  PluginUiAuthorizationAction,
  PluginUiAuthorizationPort,
  PluginUiAuthorizationResource,
  PluginUiOpaqueIdPort,
  PluginUiPackageContext,
  PluginUiPackagePort,
  PluginUiVerifiedPackage,
} from "./plugin-ui-ports.ts";
import {
  PLUGIN_UI_MAX_ASSET_BYTES,
  PLUGIN_UI_MAX_MOUNTS,
  PLUGIN_UI_MAX_TTL_MS,
  uiActor,
  uiAssetQuery,
  uiAssetResult,
  uiCatalogQuery,
  uiEpoch,
  uiInvokeCommand,
  uiLimit,
  uiMountQuery,
  uiNow,
  uiOpenCommand,
  uiOperation,
  uiOutput,
  uiPackage,
  uiProfile,
  uiProjection,
  uiPublicLease,
  uiRecord,
  uiRef,
  uiSameActor,
  uiSameScope,
  uiSelection,
} from "./plugin-ui-application-support.ts";

export type PluginUiApplicationLimits = Readonly<{
  mounts: number;
  ttlMs: number;
  assetBytes: number;
}>;
export type PluginUiApplicationDependencies = Readonly<{
  store: PluginInstallationStore;
  profiles: PluginInstallationHostProfilePort;
  authorization: PluginUiAuthorizationPort;
  packages: PluginUiPackagePort;
  actions: PluginUiActionPort;
  /** Trusted host receipt authority only; never supplied by a plugin or inferred from its JSON. */
  committedTasks?: PluginUiCommittedTaskPort;
  /** Separate trusted metadata receipt owner; does not authorize task/Run admission. */
  committedMetadata?: PluginUiCommittedMetadataPort;
  ids: PluginUiOpaqueIdPort;
  clock: ApplicationClock;
  /** Only lower limits are accepted; there is no unbounded lease or byte configuration. */
  limits?: PluginUiApplicationLimits;
}>;
type MountBinding = Readonly<{
  context: PluginUiPackageContext;
  lease: PluginUiLease;
  authorityEpoch: string;
}>;

/** Internal process-local UI admission; this is neither browser isolation nor production HTTP wiring. */
export class PluginUiApplicationService {
  readonly #dependencies: PluginUiApplicationDependencies;
  readonly #limits: PluginUiApplicationLimits;
  readonly #mounts = new Map<string, MountBinding>();
  #pending = 0;
  #referenceSequence = 0;

  constructor(dependencies: PluginUiApplicationDependencies) {
    this.#dependencies = Object.freeze({ ...dependencies });
    for (const [port, methods] of [
      [dependencies.profiles, ["resolve"]],
      [dependencies.authorization, ["authorize"]],
      [dependencies.packages, ["verify", "readAsset"]],
      [dependencies.actions, ["invoke"]],
      [dependencies.ids, ["nextId"]],
      [dependencies.clock, ["now"]],
      [dependencies.store, ["loadSelection", "loadPackage", "listSelections"]],
    ] as const)
      for (const method of methods)
        if (
          port === null ||
          port === undefined ||
          typeof (port as unknown as Record<string, unknown>)[method] !==
            "function"
        )
          throw new ApplicationError("internal", "plugin_ui_port_missing");
    if (dependencies.committedTasks !== undefined)
      for (const method of ["isOutcome", "verify"] as const)
        if (typeof dependencies.committedTasks?.[method] !== "function")
          throw new ApplicationError("internal", "plugin_ui_port_missing");
    if (dependencies.committedMetadata !== undefined)
      for (const method of ["isOutcome", "verify"] as const)
        if (typeof dependencies.committedMetadata?.[method] !== "function")
          throw new ApplicationError("internal", "plugin_ui_port_missing");
    this.#limits = uiOutput(() => {
      const value =
        dependencies.limits === undefined
          ? {
              mounts: PLUGIN_UI_MAX_MOUNTS,
              ttlMs: PLUGIN_UI_MAX_TTL_MS,
              assetBytes: PLUGIN_UI_MAX_ASSET_BYTES,
            }
          : uiRecord(dependencies.limits, ["mounts", "ttlMs", "assetBytes"]);
      return Object.freeze({
        mounts: uiLimit(value.mounts, PLUGIN_UI_MAX_MOUNTS),
        ttlMs: uiLimit(value.ttlMs, PLUGIN_UI_MAX_TTL_MS),
        assetBytes: uiLimit(value.assetBytes, PLUGIN_UI_MAX_ASSET_BYTES),
      });
    });
  }

  openMount(
    actorInput: ActorContext,
    input: OpenPluginUiMountCommand,
  ): Promise<PluginUiLease> {
    return uiOperation(async () => {
      const actor = uiActor(actorInput);
      const command = uiOpenCommand(input);
      this.#purge();
      if (this.#mounts.size + this.#pending >= this.#limits.mounts)
        throw new ApplicationError("conflict", "plugin_ui_mount_limit");
      this.#pending++;
      try {
        const scope = await this.#profile(actor);
        const resource = this.#resource(
          scope,
          command.pluginId,
          command.expectedPackageDigest,
          command.expectedSelectionRevision,
          command.contributionId,
        );
        const epoch = await this.#authorize(actor, scope, "mount", resource);
        const context = await this.#context(
          actor,
          scope,
          command.pluginId,
          command.expectedSelectionRevision,
          command.expectedPackageDigest,
        );
        await this.#fresh(context, "mount", command.contributionId, epoch);
        const verified = uiProjection(
          await this.#dependencies.packages.verify(context),
          context,
          command.contributionId,
        );
        await this.#fresh(context, "mount", command.contributionId, epoch);
        // A per-service sequence prevents late references from becoming valid again even if an ID
        // provider accidentally repeats a random component; no unbounded tombstone set is retained.
        if (this.#referenceSequence === Number.MAX_SAFE_INTEGER)
          throw new ApplicationError(
            "internal",
            "plugin_ui_reference_exhausted",
          );
        const random = uiOutput(() => uiRef(this.#dependencies.ids.nextId()));
        const mountRef = `${random.slice(0, 112)}_${(++this.#referenceSequence).toString(36)}`;
        const lease = uiPublicLease({
          schemaVersion: "crewon.plugin-ui-lease.v1",
          mountRef,
          expiresAt: new Date(this.#now() + this.#limits.ttlMs).toISOString(),
          selectionRevision: context.selection.revision,
          packageDigest: context.package.packageDigest,
          descriptor: verified.descriptor,
          contributionId: command.contributionId,
          publicAssets: verified.publicAssets,
        });
        this.#mounts.set(
          mountRef,
          Object.freeze({ context, lease, authorityEpoch: epoch }),
        );
        return lease;
      } finally {
        this.#pending--;
      }
    });
  }

  validateMount(
    actorInput: ActorContext,
    input: PluginUiMountQuery,
  ): Promise<PluginUiLease> {
    return uiOperation(async () => {
      const actor = uiActor(actorInput);
      const query = uiMountQuery(input);
      const binding = this.#binding(actor, query.mountRef);
      await this.#fence(actor, binding, "mount");
      return binding.lease;
    });
  }

  readAsset(actorInput: ActorContext, input: ReadPluginUiAssetQuery) {
    return uiOperation(async () => {
      const actor = uiActor(actorInput);
      const query = uiAssetQuery(input);
      const binding = this.#binding(actor, query.mountRef);
      if (!binding.lease.publicAssets.includes(query.path))
        throw new ApplicationError("notFound", "plugin_ui_asset_unavailable");
      const file = binding.lease.descriptor.files.find(
        (item) => item.path === query.path,
      )!;
      if (file.byteLength > this.#limits.assetBytes)
        throw new ApplicationError("validation", "plugin_ui_asset_limit");
      await this.#fence(actor, binding, "asset");
      const result = uiAssetResult(
        await this.#dependencies.packages.readAsset(
          Object.freeze({
            ...binding.context,
            lease: binding.lease,
            path: query.path,
          }),
        ),
        binding.lease,
        query.path,
        this.#limits.assetBytes,
      );
      await this.#fence(actor, binding, "asset");
      return result;
    });
  }

  closeMount(
    actorInput: ActorContext,
    input: PluginUiMountQuery,
  ): Promise<void> {
    return uiOperation(async () => {
      const actor = uiActor(actorInput);
      const query = uiMountQuery(input);
      const binding = this.#mounts.get(query.mountRef);
      if (!binding || !uiSameActor(binding.context.actor, actor))
        throw new ApplicationError("notFound", "plugin_ui_mount_unavailable");
      // Local disposal is allowed after expiry/revocation, but only the issuing actor can dispose it.
      this.#mounts.delete(query.mountRef);
    });
  }

  invoke(actorInput: ActorContext, input: InvokePluginUiActionCommand) {
    return uiOperation(async () => {
      const actor = uiActor(actorInput);
      const command = uiInvokeCommand(input);
      const binding = this.#binding(actor, command.mountRef);
      await this.#fence(actor, binding, "invoke");
      const context: PluginUiActionContext = Object.freeze({
        ...binding.context,
        lease: binding.lease,
        authorityEpoch: binding.authorityEpoch,
        action: command.action,
        input: command.input,
      });
      const unregister = registerPluginUiInvocation(
        context,
        () => this.#fence(actor, binding, "invoke"),
        () => this.#alive(binding),
      );
      try {
        const raw = await this.#dependencies.actions.invoke(context);
        const authority = this.#dependencies.committedTasks;
        if (authority?.isOutcome(raw) === true) {
          // The original transaction already admitted this task. Later selection/lease changes cannot
          // turn that accepted receipt into a retry signal; ordinary JSON retains the read fence below.
          const result = authority.verify(context, raw);
          return uiOutput(() => parsePluginUiJsonValue(result));
        }
        const metadata = this.#dependencies.committedMetadata;
        if (metadata?.isOutcome(raw) === true) {
          // A confirmed metadata commit has its own private owner; later withdrawal cannot turn it
          // into a retry signal, and this path conveys no task or credit admission.
          const result = metadata.verify(context, raw);
          return uiOutput(() => parsePluginUiJsonValue(result));
        }
        const result = uiOutput(() => parsePluginUiJsonValue(raw));
        await this.#fence(actor, binding, "invoke");
        return result;
      } finally {
        unregister();
      }
    });
  }

  catalog(
    actorInput: ActorContext,
    input: PluginUiCatalogQuery,
  ): Promise<PluginUiCatalog> {
    return uiOperation(async () => {
      const actor = uiActor(actorInput);
      const query = uiCatalogQuery(input);
      const scope = await this.#profile(actor);
      const resource = this.#resource(scope, null, null, null, null);
      const epoch = await this.#authorize(actor, scope, "catalog", resource);
      const raw = await this.#dependencies.store.listSelections({
        scope,
        ...query,
      });
      const page = uiOutput(() => {
        const value = uiRecord(raw, ["selections", "next"]);
        if (
          !Array.isArray(value.selections) ||
          Object.getPrototypeOf(value.selections) !== Array.prototype ||
          value.selections.length > query.limit ||
          Reflect.ownKeys(value.selections).length !==
            value.selections.length + 1
        )
          throw new Error("plugin_ui_page_invalid");
        const selections = Array.from(
          { length: value.selections.length },
          (_, index) => {
            const item = Object.getOwnPropertyDescriptor(
              value.selections,
              String(index),
            );
            if (!item || !Object.hasOwn(item, "value") || !item.enumerable)
              throw new Error("plugin_ui_page_invalid");
            const parsed = uiSelection(
              item.value,
              scope,
              uiOutput(() => {
                const id = Object.getOwnPropertyDescriptor(
                  item.value,
                  "pluginId",
                );
                if (!id || !Object.hasOwn(id, "value"))
                  throw new Error("plugin_ui_page_invalid");
                return id.value;
              }),
            );
            return parsed;
          },
        );
        let previous = query.afterPluginId;
        for (const selection of selections) {
          if (previous !== null && selection.pluginId <= previous)
            throw new Error("plugin_ui_page_order_invalid");
          previous = selection.pluginId;
        }
        if (
          value.next !== null &&
          (selections.length !== query.limit || value.next !== previous)
        )
          throw new Error("plugin_ui_page_cursor_invalid");
        return { selections, next: value.next as string | null };
      });
      const plugins: PluginUiCatalogItem[] = [];
      for (const selection of page.selections) {
        if (selection.state !== "enabled") continue;
        const context = await this.#context(
          actor,
          scope,
          selection.pluginId,
          selection.revision,
          selection.selectedPackageDigest!,
        );
        const pluginResource = this.#resource(
          scope,
          selection.pluginId,
          context.package.packageDigest,
          selection.revision,
          null,
        );
        const pluginEpoch = await this.#authorize(
          actor,
          scope,
          "catalog",
          pluginResource,
        );
        let verified: PluginUiVerifiedPackage;
        try {
          verified = await this.#dependencies.packages.verify(context);
        } catch (error) {
          if (
            !(error instanceof ApplicationError) ||
            error.category !== "conflict" ||
            ![
              "plugin_ui_mode_unsupported",
              "plugin_ui_contribution_unsupported",
            ].includes(error.code)
          )
            throw error;
          await this.#fresh(context, "catalog", null, pluginEpoch);
          continue;
        }
        const descriptor = uiOutput(() => {
          const parsed = parsePluginPackageDescriptor(
            uiRecord(verified, ["descriptor", "publicAssets"]).descriptor,
          );
          if (
            parsed.pluginId !== context.package.pluginId ||
            parsed.version !== context.package.version ||
            parsed.publisherId !== context.package.publisherId
          )
            throw new Error("plugin_ui_package_identity_invalid");
          return parsed;
        });
        const contribution = descriptor.contributions.find(
          (item) => item.kind === "module" && item.slot === "main.content",
        );
        if (
          descriptor.entrypoints.ui?.mode !== "trustedModule" ||
          !contribution
        ) {
          await this.#fresh(context, "catalog", null, pluginEpoch);
          continue;
        }
        const projection = uiProjection(verified, context, contribution.id);
        await this.#fresh(context, "catalog", null, pluginEpoch);
        plugins.push(
          Object.freeze({
            ...projection,
            selectionRevision: selection.revision,
            packageDigest: context.package.packageDigest,
          }),
        );
      }
      const currentEpoch = await this.#authorize(
        actor,
        scope,
        "catalog",
        resource,
      );
      if (currentEpoch !== epoch)
        throw new ApplicationError(
          "authorization",
          "plugin_ui_authority_changed",
        );
      return Object.freeze({
        plugins: Object.freeze(plugins),
        next: page.next,
      });
    });
  }

  async #profile(actor: ActorContext): Promise<PluginProfileScope> {
    return uiProfile(await this.#dependencies.profiles.resolve(actor), actor);
  }
  #resource(
    scope: PluginProfileScope,
    pluginId: string | null,
    packageDigest: string | null,
    selectionRevision: number | null,
    contributionId: string | null,
  ): PluginUiAuthorizationResource {
    return Object.freeze({
      kind: "pluginUi",
      ...scope,
      pluginId,
      packageDigest,
      selectionRevision,
      contributionId,
    });
  }
  async #authorize(
    actor: ActorContext,
    scope: PluginProfileScope,
    action: PluginUiAuthorizationAction,
    resource: PluginUiAuthorizationResource,
  ): Promise<string> {
    const current = await this.#profile(actor);
    if (!uiSameScope(current, scope))
      throw new ApplicationError("authorization", "plugin_ui_profile_changed");
    try {
      const raw = await this.#dependencies.authorization.authorize(
        Object.freeze({ actor, action, resource }),
      );
      const outcome =
        raw !== null && typeof raw === "object"
          ? Object.getOwnPropertyDescriptor(raw, "outcome")
          : undefined;
      if (!outcome || !Object.hasOwn(outcome, "value"))
        throw new Error("plugin_ui_authorization_invalid");
      const value = uiRecord(
        raw,
        outcome.value === "allow"
          ? ["outcome", "authorityEpoch"]
          : ["outcome", "reasonCode"],
      );
      if (value.outcome === "deny" && typeof value.reasonCode === "string")
        throw new ApplicationError(
          "authorization",
          "plugin_ui_authorization_denied",
        );
      if (value.outcome !== "allow")
        throw new Error("plugin_ui_authorization_invalid");
      const epoch = uiEpoch(value.authorityEpoch);
      const after = await this.#profile(actor);
      if (!uiSameScope(after, scope))
        throw new ApplicationError(
          "authorization",
          "plugin_ui_profile_changed",
        );
      return epoch;
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError(
        "authorization",
        "plugin_ui_authorization_unavailable",
        { cause: error },
      );
    }
  }
  async #context(
    actor: ActorContext,
    scope: PluginProfileScope,
    pluginId: string,
    revision: number,
    digest: string,
  ): Promise<PluginUiPackageContext> {
    const raw = await this.#dependencies.store.loadSelection({
      scope,
      pluginId,
    });
    if (raw === null)
      throw new ApplicationError("notFound", "plugin_ui_selection_unavailable");
    const selection = uiSelection(raw, scope, pluginId);
    if (
      selection.state !== "enabled" ||
      selection.revision !== revision ||
      selection.selectedPackageDigest !== digest
    )
      throw new ApplicationError("conflict", "plugin_ui_selection_changed");
    const pkgRaw = await this.#dependencies.store.loadPackage({
      scope,
      packageDigest: digest,
    });
    if (pkgRaw === null)
      throw new ApplicationError("internal", "plugin_ui_package_missing");
    const pkg = uiPackage(pkgRaw, scope, selection);
    return Object.freeze({ actor, scope, selection, package: pkg });
  }
  async #fresh(
    context: PluginUiPackageContext,
    action: PluginUiAuthorizationAction,
    contributionId: string | null,
    epoch: string,
  ): Promise<void> {
    const resource = this.#resource(
      context.scope,
      context.selection.pluginId,
      context.package.packageDigest,
      context.selection.revision,
      contributionId,
    );
    const before = await this.#authorize(
      context.actor,
      context.scope,
      action,
      resource,
    );
    if (before !== epoch)
      throw new ApplicationError(
        "authorization",
        "plugin_ui_authority_changed",
      );
    const current = await this.#context(
      context.actor,
      context.scope,
      context.selection.pluginId,
      context.selection.revision,
      context.package.packageDigest,
    );
    if (
      JSON.stringify(current.selection) !== JSON.stringify(context.selection) ||
      JSON.stringify(current.package) !== JSON.stringify(context.package)
    )
      throw new ApplicationError(
        "internal",
        "plugin_ui_record_changed_without_revision",
      );
    const after = await this.#authorize(
      context.actor,
      context.scope,
      action,
      resource,
    );
    if (after !== epoch)
      throw new ApplicationError(
        "authorization",
        "plugin_ui_authority_changed",
      );
  }
  #binding(actor: ActorContext, mountRef: string): MountBinding {
    const binding = this.#mounts.get(mountRef);
    if (!binding || !uiSameActor(actor, binding.context.actor))
      throw new ApplicationError("notFound", "plugin_ui_mount_unavailable");
    this.#alive(binding);
    return binding;
  }
  #alive(binding: MountBinding): void {
    if (this.#mounts.get(binding.lease.mountRef) !== binding)
      throw new ApplicationError("notFound", "plugin_ui_mount_unavailable");
    if (this.#now() >= Date.parse(binding.lease.expiresAt)) {
      this.#mounts.delete(binding.lease.mountRef);
      throw new ApplicationError("conflict", "plugin_ui_mount_expired");
    }
  }
  async #fence(
    actor: ActorContext,
    binding: MountBinding,
    action: PluginUiAuthorizationAction,
  ): Promise<void> {
    this.#alive(binding);
    if (!uiSameActor(actor, binding.context.actor))
      throw new ApplicationError("notFound", "plugin_ui_mount_unavailable");
    try {
      await this.#fresh(
        binding.context,
        action,
        binding.lease.contributionId,
        binding.authorityEpoch,
      );
    } catch (error) {
      if (
        error instanceof ApplicationError &&
        [
          "plugin_ui_selection_changed",
          "plugin_ui_selection_unavailable",
          "plugin_ui_authority_changed",
          "plugin_ui_profile_changed",
        ].includes(error.code)
      )
        this.#mounts.delete(binding.lease.mountRef);
      throw error;
    }
    this.#alive(binding);
  }
  #now(): number {
    return uiOutput(() => uiNow(this.#dependencies.clock.now()));
  }
  #purge(): void {
    const now = this.#now();
    for (const [reference, binding] of this.#mounts)
      if (Date.parse(binding.lease.expiresAt) <= now)
        this.#mounts.delete(reference);
  }
}
