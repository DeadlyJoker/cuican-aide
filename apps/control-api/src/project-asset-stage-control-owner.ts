import {
  ApplicationError,
  ProjectAssetStageApplicationService,
  assertPluginUiInvocationCurrent,
  capturePluginUiInvocationCommitAuthority,
  type ActorContext,
  type PluginInstallationStore,
  type PluginUiActionContext,
  type PluginUiActionPort,
  type PluginUiAuthorizationPort,
  type PluginUiCommittedMetadataOutcome,
  type PluginUiCommittedMetadataPort,
  type PluginUiJsonValue,
  type ProjectAssetStageCommitAuthority,
  type ProjectConversationStore,
  type ProjectToolInstallationPin,
} from "@crewon/application";
import {
  extensionCanonicalJson,
  parseInstalledPluginPackage,
  parsePluginSelection,
  parsePluginTaskAdmissionPin,
} from "@crewon/domain";
import {
  loadInstalledPluginBusinessRegistration,
  verifyLocalPluginPackage,
  verifyInstalledProjectActionDeclaration,
  type PluginActivationCandidate,
} from "@crewon/plugin-host";
import {
  PROJECT_ASSET_STAGES_METHOD_ACTIONS as actions,
  parseProjectAssetStagesActionRequest,
  parseProjectAssetStagesActionResponse,
  type ProjectAssetStageRequest,
  parseProjectAssetScriptSourceRequest,
  type ProjectAssetScriptSourceRequest,
} from "@crewon/contracts/project-asset-stages";
import { parsePluginUiJsonValue } from "@crewon/contracts/plugins";
import { join } from "node:path";
import type { ControlApiRequestContext } from "./control-api-ports.ts";
import type { InstalledPluginRequestOwner } from "./installed-plugin-request-owner.ts";
import type { InstalledPluginTaskActionOwnerDependencies } from "./installed-plugin-task-action-owner.ts";
import type { ProjectAssetCompositionConfig } from "./project-asset-composition.ts";
export type ProjectAssetStageControlDependencies = Readonly<{
  service: ProjectAssetStageApplicationService;
  conversations: Pick<ProjectConversationStore, "loadBinding">;
  configuration: NonNullable<ProjectAssetCompositionConfig["assetStages"]>;
  installations: Pick<PluginInstallationStore, "loadSelection" | "loadPackage">;
  requests: InstalledPluginRequestOwner;
  installRoot: string;
  authorization: PluginUiAuthorizationPort;
  authorizePackage: InstalledPluginTaskActionOwnerDependencies["authorizePackage"];
  assertExternal(actor: ActorContext): void;
  /** Actual original execution owner readiness; metadata publication alone is not readiness. */
  executionAvailable(): boolean;
}>;
type Outcome = Readonly<{
  context: PluginUiActionContext;
  fingerprint: string;
  output: PluginUiJsonValue;
}>;
const genuineOwners = new WeakSet<object>();
export function isProjectAssetStageControlOwner(
  input: unknown,
): input is ProjectAssetStageControlOwner {
  return (
    input !== null && typeof input === "object" && genuineOwners.has(input)
  );
}
const outcomePrototype = Object.freeze(Object.create(null) as object);
/** Independently approved asset execution. The old conversation metadata owner grants no asset permission. */
export class ProjectAssetStageControlOwner {
  readonly actions: PluginUiActionPort;
  readonly committedMetadata: PluginUiCommittedMetadataPort;
  readonly #input: ProjectAssetStageControlDependencies;
  readonly #physical = new Set<Promise<unknown>>();
  readonly #outcomes = new WeakMap<object, Outcome>();
  #closed = false;
  #closing: Promise<void> | undefined;
  constructor(input: ProjectAssetStageControlDependencies) {
    if (
      !(input.service instanceof ProjectAssetStageApplicationService) ||
      input.configuration.version !== "crewon.project-asset-stages.v1" ||
      typeof input.executionAvailable !== "function"
    )
      throw new Error("project_asset_stage_service_required");
    this.#input = Object.freeze({
      ...input,
      configuration: Object.freeze({
        version: input.configuration.version,
        publications: Object.freeze(
          input.configuration.publications.map((p) => Object.freeze({ ...p })),
        ),
      }),
      installations: Object.freeze({
        loadSelection: input.installations.loadSelection.bind(
          input.installations,
        ),
        loadPackage: input.installations.loadPackage.bind(input.installations),
      }),
      conversations: Object.freeze({
        loadBinding: input.conversations.loadBinding.bind(input.conversations),
      }),
      authorization: Object.freeze({
        authorize: input.authorization.authorize.bind(input.authorization),
      }),
      authorizePackage: input.authorizePackage.bind(input),
      assertExternal: input.assertExternal.bind(input),
      executionAvailable: input.executionAvailable.bind(input),
    });
    genuineOwners.add(this);
    this.actions = Object.freeze({
      invoke: (context: PluginUiActionContext) =>
        this.#track(() => this.#invoke(context)),
    });
    this.committedMetadata = Object.freeze({
      isOutcome: (value: unknown): value is PluginUiCommittedMetadataOutcome =>
        value !== null &&
        typeof value === "object" &&
        this.#outcomes.has(value),
      verify: (
        context: PluginUiActionContext,
        value: PluginUiCommittedMetadataOutcome,
      ) => {
        const result = this.#outcomes.get(value);
        if (
          result === undefined ||
          result.context !== context ||
          result.fingerprint !== fingerprint(context)
        )
          denied();
        this.#outcomes.delete(value);
        return result.output;
      },
    });
  }
  supportsAction(action: string) {
    return action === actions.startStage;
  }
  assertAvailable() {
    if (this.#closed) unavailable();
  }
  close(): Promise<void> {
    this.#closed = true;
    return (this.#closing ??= Promise.allSettled([...this.#physical]).then(
      () => {},
    ));
  }
  runAuthenticatedRequest<T>(
    request: ControlApiRequestContext,
    actor: ActorContext,
    action: string,
    signal: AbortSignal | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    this.assertAvailable();
    if (!this.supportsAction(action)) unavailable();
    return this.#input.requests.run({ request, actor, signal }, work);
  }
  getAvailability(
    request: ControlApiRequestContext,
    actor: ActorContext,
    threadId: string,
    signal?: AbortSignal,
  ) {
    return this.#track(() =>
      this.#input.requests.run(
        { request, actor, signal, preparation: "configuration" },
        async () => {
          await this.#input.requests.assertCurrent();
          const b = await this.#input.conversations.loadBinding({
            actor,
            profileId: this.#input.requests.currentScope().profileId,
            threadId,
          });
          if (
            b === null ||
            !this.#input.configuration.publications.some(
              (p) =>
                p.pluginId === b.currentInstallation.pluginId &&
                p.packageDigest === b.currentInstallation.packageDigest,
            )
          )
            return { available: false };
          const executionAvailable = this.#input.executionAvailable();
          if (typeof executionAvailable !== "boolean") unavailable();
          const q = await this.#issue(
            actor,
            b.currentInstallation,
            executionAvailable ? "execute" : "read",
          );
          const projectAvailable = await this.#input.service.isAvailable(
            actor,
            threadId,
            q,
          );
          const stillAvailable = this.#input.executionAvailable();
          if (typeof stillAvailable !== "boolean") unavailable();
          q.assertActive();
          return {
            available: projectAvailable && executionAvailable && stillAvailable,
          };
        },
      ),
    );
  }
  startStage(
    request: ControlApiRequestContext,
    actor: ActorContext,
    input: ProjectAssetStageRequest,
    signal?: AbortSignal,
  ) {
    return this.#track(() =>
      this.runAuthenticatedRequest(
        request,
        actor,
        actions.startStage,
        signal,
        async () => {
          const parsed = parseProjectAssetStagesActionRequest({
            action: actions.startStage,
            input,
          });
          await this.#input.requests.assertCurrent();
          const b = await this.#input.conversations.loadBinding({
            actor,
            profileId: this.#input.requests.currentScope().profileId,
            threadId: parsed.input.threadId,
          });
          if (b === null || b.projectId !== parsed.input.projectId) denied();
          const q = await this.#issue(actor, b.currentInstallation, "execute");
          return this.#input.service.startStage(actor, parsed.input, q);
        },
      ),
    );
  }
  getScriptSource(
    request: ControlApiRequestContext,
    actor: ActorContext,
    input: ProjectAssetScriptSourceRequest,
    signal?: AbortSignal,
  ) {
    return this.#track(() =>
      this.#input.requests.run(
        { request, actor, signal, preparation: "configuration" },
        async () => {
          const parsed = parseProjectAssetScriptSourceRequest(input);
          await this.#input.requests.assertCurrent();
          const b = await this.#input.conversations.loadBinding({
            actor,
            profileId: this.#input.requests.currentScope().profileId,
            threadId: parsed.threadId,
          });
          if (b === null || b.projectId !== parsed.projectId) denied();
          const q = await this.#issue(actor, b.currentInstallation, "read");
          return this.#input.service.getScriptSource(actor, parsed, q);
        },
      ),
    );
  }
  async #invoke(context: PluginUiActionContext) {
    this.assertAvailable();
    await assertPluginUiInvocationCurrent(context);
    const parsed = parseProjectAssetStagesActionRequest({
      action: context.action,
      input: context.input,
    });
    const q = await this.#issue(
      context.actor,
      {
        tenantId: context.scope.tenantId,
        spaceId: context.scope.spaceId,
        profileId: context.scope.profileId,
        pluginId: context.package.pluginId,
        publisherId: context.package.publisherId,
        version: context.package.version,
        packageDigest: context.package.packageDigest,
        selectionRevision: context.selection.revision,
      },
      "execute",
    );
    const live = capturePluginUiInvocationCommitAuthority(context);
    const actual: ProjectAssetStageCommitAuthority = Object.freeze({
      ...q,
      assertCurrent: async () => {
        await assertPluginUiInvocationCurrent(context);
        await q.assertCurrent();
        await assertPluginUiInvocationCurrent(context);
      },
      assertActive: () => {
        live.assertActive();
        q.assertActive();
        live.assertActive();
      },
      assertTransactionCurrent: async () => {
        live.assertActive();
        await q.assertTransactionCurrent();
        live.assertActive();
      },
    });
    const output = parsePluginUiJsonValue(
      parseProjectAssetStagesActionResponse(
        parsed,
        await this.#input.service.startStage(
          context.actor,
          parsed.input,
          actual,
        ),
      ),
    );
    const opaque = Object.freeze(Object.create(outcomePrototype));
    this.#outcomes.set(
      opaque,
      Object.freeze({ context, fingerprint: fingerprint(context), output }),
    );
    return opaque as PluginUiCommittedMetadataOutcome;
  }
  async #issue(
    actor: ActorContext,
    expected: ProjectToolInstallationPin,
    purpose: "read" | "execute",
  ): Promise<ProjectAssetStageCommitAuthority> {
    this.assertAvailable();
    await this.#input.requests.assertCurrent();
    const scope = this.#input.requests.currentScope();
    if (
      !same(actor, this.#input.requests.currentActor()) ||
      expected.tenantId !== scope.tenantId ||
      expected.spaceId !== scope.spaceId ||
      expected.profileId !== scope.profileId
    )
      denied();
    const selectionRaw = await this.#input.installations.loadSelection({
      scope,
      pluginId: expected.pluginId,
    });
    if (selectionRaw === null) denied();
    const selection = parsePluginSelection(selectionRaw);
    if (
      selection.state !== "enabled" ||
      selection.selectedPackageDigest !== expected.packageDigest ||
      selection.revision !== expected.selectionRevision ||
      selection.publisherId !== expected.publisherId
    )
      denied();
    const packageRaw = await this.#input.installations.loadPackage({
      scope,
      packageDigest: expected.packageDigest,
    });
    if (packageRaw === null) denied();
    const pkg = parseInstalledPluginPackage(packageRaw);
    if (
      pkg.pluginId !== expected.pluginId ||
      pkg.publisherId !== expected.publisherId ||
      pkg.version !== expected.version ||
      !same(scope, {
        tenantId: pkg.tenantId,
        spaceId: pkg.spaceId,
        profileId: pkg.profileId,
      })
    )
      denied();
    const publication = this.#input.configuration.publications.find(
      (entry) =>
        entry.pluginId === pkg.pluginId &&
        entry.packageDigest === pkg.packageDigest,
    );
    if (publication === undefined || publication.contributionId !== "workbench")
      denied();
    const signal = this.#input.requests.currentSignal();
    const candidate = await verifyLocalPluginPackage({
      directory: join(
        this.#input.installRoot,
        "packages",
        pkg.packageDigest.slice(7),
      ),
      signal,
    });
    const checked: PluginActivationCandidate = {
      descriptor: candidate.descriptor,
      packageDigest: candidate.packageDigest,
    };
    if (
      candidate.packageDigest !== pkg.packageDigest ||
      candidate.descriptor.pluginId !== pkg.pluginId ||
      candidate.descriptor.publisherId !== pkg.publisherId ||
      candidate.descriptor.version !== pkg.version ||
      candidate.descriptor.entrypoints.node === null ||
      !candidate.descriptor.contributions.some(
        (entry) =>
          entry.id === publication.contributionId &&
          entry.kind === "module" &&
          entry.slot === "main.content",
      ) ||
      candidate.descriptor.businessManifestPath === null ||
      !candidate.descriptor.requires.some(
        (entry) =>
          entry.service === "crewon.project-asset-stages" &&
          entry.apiVersion === "1",
      )
    )
      denied();
    if (
      (await this.#input.authorizePackage(
        { actor, scope, candidate: checked, purpose: "read" },
        signal,
      )) !== "allow"
    )
      denied();
    const registration = await loadInstalledPluginBusinessRegistration({
      installRoot: this.#input.installRoot,
      expectedPluginId: pkg.pluginId,
      expectedPublisherId: pkg.publisherId,
      expectedVersion: pkg.version,
      expectedPackageDigest: pkg.packageDigest,
      signal,
      authorizeRead: async () =>
        this.#input.authorizePackage(
          { actor, scope, candidate: checked, purpose: "read" },
          signal,
        ),
    });
    if (
      registration.manifest.pluginId !== pkg.pluginId ||
      registration.manifest.version !== pkg.version
    )
      denied();
    const resource = {
      kind: "pluginUi" as const,
      ...scope,
      pluginId: pkg.pluginId,
      packageDigest: pkg.packageDigest,
      selectionRevision: selection.revision,
      contributionId: publication.contributionId,
    };
    const decision = await this.#input.authorization.authorize({
      actor,
      action: "invoke",
      resource,
    });
    if (decision.outcome !== "allow") denied();
    const pin = parsePluginTaskAdmissionPin({
      ...expected,
      principalId: actor.principalId,
      actorId: actor.actorId,
      contributionId: publication.contributionId,
      action: "project.execute",
      authorityEpoch: decision.authorityEpoch,
    });
    const assertActive = () => {
      this.assertAvailable();
      signal.throwIfAborted();
      this.#input.assertExternal(actor);
      if (
        !same(actor, this.#input.requests.currentActor()) ||
        !same(scope, this.#input.requests.currentScope())
      )
        denied();
    };
    const assertTransactionCurrent = async () => {
      assertActive();
      await this.#input.requests.assertCurrent();
      const current = await this.#input.authorization.authorize({
        actor,
        action: "invoke",
        resource,
      });
      if (
        current.outcome !== "allow" ||
        current.authorityEpoch !== pin.authorityEpoch
      )
        denied();
      if (
        (await this.#input.authorizePackage(
          {
            actor,
            scope,
            candidate: checked,
            purpose: purpose === "execute" ? "submit" : "read",
          },
          signal,
        )) !== "allow"
      )
        denied();
      assertActive();
    };
    const assertCurrent = async () => {
      await assertTransactionCurrent();
      const current = await this.#input.installations.loadSelection({
        scope,
        pluginId: pkg.pluginId,
      });
      const currentPackage = await this.#input.installations.loadPackage({
        scope,
        packageDigest: pkg.packageDigest,
      });
      if (
        current === null ||
        currentPackage === null ||
        !same(parsePluginSelection(current), selection) ||
        !same(parseInstalledPluginPackage(currentPackage), pkg)
      )
        denied();
      const currentBytes = await verifyLocalPluginPackage({
        directory: candidate.directory,
        signal,
      });
      if (
        currentBytes.packageDigest !== pkg.packageDigest ||
        !same(currentBytes.descriptor, candidate.descriptor)
      )
        denied();
      assertActive();
    };
    await assertCurrent();
    {
      await verifyInstalledProjectActionDeclaration({
        installRoot: this.#input.installRoot,
        pluginId: pkg.pluginId,
        packageDigest: pkg.packageDigest,
        contributionId: publication.contributionId,
        assertActive,
        assertCurrent: async (actual) => {
          await assertCurrent();
          if (
            actual.packageDigest !== pkg.packageDigest ||
            !same(actual.descriptor, candidate.descriptor) ||
            (await this.#input.authorizePackage(
              {
                actor,
                scope,
                candidate: actual,
                purpose: purpose === "execute" ? "submit" : "read",
              },
              signal,
            )) !== "allow"
          )
            denied();
          await assertCurrent();
        },
      });
      await assertCurrent();
    }
    return Object.freeze({
      version: "crewon.project-asset-stage-commit.v1",
      actor,
      installation: expected,
      selection,
      package: pkg,
      pin,
      assertCurrent,
      assertTransactionCurrent,
      assertActive,
    });
  }
  #track<T>(work: () => Promise<T>): Promise<T> {
    this.assertAvailable();
    if (this.#physical.size >= 128) unavailable();
    const result = Promise.resolve().then(work);
    this.#physical.add(result);
    void result.then(
      () => this.#physical.delete(result),
      () => this.#physical.delete(result),
    );
    return result;
  }
}
function same(a: unknown, b: unknown) {
  return extensionCanonicalJson(a) === extensionCanonicalJson(b);
}
function fingerprint(context: PluginUiActionContext) {
  return extensionCanonicalJson([
    context.actor,
    context.scope,
    context.selection,
    context.package,
    context.lease,
    context.authorityEpoch,
    context.action,
    context.input,
  ]);
}
function denied(): never {
  throw new ApplicationError(
    "authorization",
    "project_asset_stage_authority_changed",
  );
}
function unavailable(): never {
  throw new ApplicationError("conflict", "project_asset_stage_unavailable");
}
