import {
  ApplicationError,
  ProjectConversationApplicationService,
  assertPluginUiInvocationCurrent,
  capturePluginUiInvocationCommitAuthority,
  type ActorContext,
  type ApplicationClock,
  type ContentDigester,
  type PluginInstallationStore,
  type PluginUiActionContext,
  type PluginUiActionPort,
  type PluginUiAuthorizationPort,
  type PluginUiCommittedMetadataOutcome,
  type PluginUiCommittedMetadataPort,
  type PluginUiJsonValue,
  type ProjectConversationCommitAuthority,
  type ProjectConversationStore,
} from "@crewon/application";
import {
  extensionCanonicalJson,
  parseInstalledPluginPackage,
  parsePluginSelection,
  parsePluginTaskAdmissionPin,
  type ProjectConversationInstallation,
} from "@crewon/domain";
import {
  loadInstalledPluginBusinessRegistration,
  verifyLocalPluginPackage,
  verifyInstalledProjectActionDeclaration,
  type PluginActivationCandidate,
} from "@crewon/plugin-host";
import {
  PROJECT_CONVERSATIONS_METHOD_ACTIONS as actions,
  parseProjectConversationsActionRequest,
  parseProjectConversationsActionResponse,
  type ProjectConversationsUiActionRequest,
} from "@crewon/contracts/project-conversations";
import { parsePluginUiJsonValue } from "@crewon/contracts/plugins";
import {
  PROJECT_CONVERSATION_ASSOCIATION_ACTIONS as associationActions,
  parseProjectConversationAssociationRequest,
  parseProjectConversationAssociationResponse,
  type ProjectConversationAssociationRequest,
} from "@crewon/contracts/project-conversation-association";
import { join } from "node:path";
import {
  captureProjectConversationNativeProvisioning,
  createNativeProvisionedProjectConversation,
  type ProjectConversationNativeProvisioning,
} from "./project-conversation-native-provisioning.ts";
import type { ControlApiRequestContext } from "./control-api-ports.ts";
import type { InstalledPluginRequestOwner } from "./installed-plugin-request-owner.ts";
import type { ProjectConversationConfiguration } from "./project-conversation-composition.ts";
import type { InstalledPluginTaskActionOwnerDependencies } from "./installed-plugin-task-action-owner.ts";

export type ProjectConversationControlDependencies = Readonly<{
  service: ProjectConversationApplicationService;
  projectOwnership?: "plugin-project-v1";
  nativeWorkspace?: ProjectConversationNativeProvisioning;
  conversations: ProjectConversationStore;
  configuration: ProjectConversationConfiguration;
  installations: Pick<PluginInstallationStore, "loadSelection" | "loadPackage">;
  requests: InstalledPluginRequestOwner;
  installRoot: string;
  authorization: PluginUiAuthorizationPort;
  authorizePackage: InstalledPluginTaskActionOwnerDependencies["authorizePackage"];
  assertExternal(actor: ActorContext): void;
  clock: ApplicationClock;
  digester: ContentDigester;
}>;
type Outcome = Readonly<{
  context: PluginUiActionContext;
  fingerprint: string;
  output: PluginUiJsonValue;
}>;
const outcomePrototype = Object.freeze(Object.create(null) as object);

/** Trusted Control owns current installation and request evidence. Public requests supply no admission pin. */
export class ProjectConversationControlOwner {
  readonly actions: PluginUiActionPort;
  readonly committedMetadata: PluginUiCommittedMetadataPort;
  readonly #input: ProjectConversationControlDependencies;
  readonly #outcomes = new WeakMap<object, Outcome>();
  readonly #physical = new Set<Promise<unknown>>();
  #closed = false;
  #closing: Promise<void> | undefined;
  constructor(input: ProjectConversationControlDependencies) {
    if (!(input.service instanceof ProjectConversationApplicationService))
      throw new Error("project_conversation_service_required");
    if (
      input.projectOwnership !== undefined &&
      input.projectOwnership !== "plugin-project-v1"
    )
      throw new Error("project_conversation_project_ownership_invalid");
    const nativeDescriptor = Object.getOwnPropertyDescriptor(
      input,
      "nativeWorkspace",
    );
    if (
      ("nativeWorkspace" in input && nativeDescriptor === undefined) ||
      (nativeDescriptor !== undefined &&
        (!nativeDescriptor.enumerable ||
          !Object.hasOwn(nativeDescriptor, "value")))
    )
      throw new Error("project_conversation_native_provisioning_invalid");
    const nativeWorkspace = captureProjectConversationNativeProvisioning(
      nativeDescriptor?.value,
      input.projectOwnership,
    );
    this.#input = Object.freeze({
      ...input,
      nativeWorkspace,
      configuration: Object.freeze({
        publications: Object.freeze(
          input.configuration.publications.map((entry) =>
            Object.freeze({ ...entry }),
          ),
        ),
      }),
      installations: Object.freeze({
        loadSelection: input.installations.loadSelection.bind(
          input.installations,
        ),
        loadPackage: input.installations.loadPackage.bind(input.installations),
      }),
      assertExternal: input.assertExternal.bind(input),
      authorizePackage: input.authorizePackage.bind(input),
      authorization: Object.freeze({
        authorize: input.authorization.authorize.bind(input.authorization),
      }),
    });
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
  supportsAction(action: string): boolean {
    return (
      Object.values(actions).includes(action as never) ||
      Object.values(associationActions).includes(action as never)
    );
  }
  assertAvailable(): void {
    if (this.#closed) unavailable();
  }
  close(): Promise<void> {
    this.#closed = true;
    return (this.#closing ??= Promise.allSettled([...this.#physical]).then(
      () => {},
    ));
  }
  hasThreadBinding(
    tenantId: string,
    spaceId: string,
    threadId: string,
  ): Promise<boolean> {
    this.assertAvailable();
    return this.#input.conversations.hasThreadBinding({
      tenantId,
      spaceId,
      threadId,
    });
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
    return this.#input.requests.run(
      {
        request,
        actor,
        signal,
        ...(action === actions.startStage
          ? {}
          : { preparation: "configuration" as const }),
      },
      work,
    );
  }
  async getBinding(
    request: ControlApiRequestContext,
    actor: ActorContext,
    threadId: string,
    signal?: AbortSignal,
  ) {
    return this.#track(() =>
      this.runAuthenticatedRequest(
        request,
        actor,
        actions.getBinding,
        signal,
        async () => {
          const binding = await this.#binding(actor, threadId);
          if (binding === null) {
            if (
              await this.hasThreadBinding(
                actor.tenantId,
                actor.spaceId,
                threadId,
              )
            )
              denied();
            return { binding: null };
          }
          const authority = await this.#issue(
            actor,
            binding.currentInstallation,
          );
          return this.#input.service.getBinding(actor, { threadId }, authority);
        },
      ),
    );
  }
  async startStage(
    request: ControlApiRequestContext,
    actor: ActorContext,
    raw: unknown,
    signal?: AbortSignal,
  ) {
    const parsed = parseProjectConversationsActionRequest({
      action: actions.startStage,
      input: raw,
    });
    if (parsed.action !== actions.startStage) unavailable();
    return this.#track(() =>
      this.runAuthenticatedRequest(
        request,
        actor,
        parsed.action,
        signal,
        async () => {
          const binding = await this.#binding(actor, parsed.input.threadId);
          if (binding === null) denied();
          const authority = await this.#issue(
            actor,
            binding.currentInstallation,
            "execute",
          );
          return this.#input.service.startStage(actor, parsed.input, authority);
        },
      ),
    );
  }
  async startBoundTurn(
    request: ControlApiRequestContext,
    actor: ActorContext,
    input: Readonly<{
      threadId: string;
      expectedThreadRevision: number;
      content: string;
      idempotencyKey: string;
    }>,
    signal?: AbortSignal,
  ) {
    return this.#track(() =>
      this.runAuthenticatedRequest(
        request,
        actor,
        actions.startStage,
        signal,
        async () => {
          const binding = await this.#binding(actor, input.threadId);
          if (binding === null) denied();
          const authority = await this.#issue(
            actor,
            binding.currentInstallation,
            "execute",
          );
          return this.#input.service.startProjectTurn(
            actor,
            {
              projectId: binding.projectId,
              threadId: input.threadId,
              expectedThreadRevision: input.expectedThreadRevision,
              expectedBindingRevision: binding.revision,
              content: input.content,
              idempotencyKey: input.idempotencyKey,
              stage: { kind: "discussion" },
            },
            authority,
          );
        },
      ),
    );
  }
  async #invoke(context: PluginUiActionContext) {
    this.assertAvailable();
    await assertPluginUiInvocationCurrent(context);
    const association = Object.values(associationActions).includes(
      context.action as never,
    );
    const request = association
      ? this.#associationRequest(context)
      : parseProjectConversationsActionRequest({
          action: context.action,
          input: context.input,
        });
    const authority = await this.#issue(
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
      association
        ? "association"
        : request.action === actions.startStage
          ? "execute"
          : "metadata",
    );
    const original = authority.assertCurrent;
    const live = capturePluginUiInvocationCommitAuthority(context);
    const actualAuthority: ProjectConversationCommitAuthority = Object.freeze({
      ...authority,
      assertCurrent: async () => {
        await assertPluginUiInvocationCurrent(context);
        await original();
        await assertPluginUiInvocationCurrent(context);
      },
      assertActive: () => {
        live.assertActive();
        authority.assertActive();
        live.assertActive();
      },
      assertTransactionCurrent: async () => {
        live.assertActive();
        await authority.assertTransactionCurrent();
        live.assertActive();
      },
    });
    const output = parsePluginUiJsonValue(
      request.action === associationActions.inspect ||
        request.action === associationActions.attach
        ? parseProjectConversationAssociationResponse(
            request,
            await this.#dispatch(
              context.actor,
              request,
              actualAuthority,
              context,
            ),
          )
        : parseProjectConversationsActionResponse(
            request,
            await this.#dispatch(
              context.actor,
              request,
              actualAuthority,
              context,
            ),
          ),
    );
    if (
      request.action === actions.createConversation ||
      request.action === associationActions.attach ||
      request.action === actions.refreshSource ||
      request.action === actions.setState ||
      request.action === actions.startStage
    ) {
      const opaque = Object.freeze(Object.create(outcomePrototype));
      this.#outcomes.set(
        opaque,
        Object.freeze({ context, fingerprint: fingerprint(context), output }),
      );
      return opaque as PluginUiCommittedMetadataOutcome;
    }
    await actualAuthority.assertCurrent();
    return output;
  }
  #associationRequest(
    context: PluginUiActionContext,
  ): ProjectConversationAssociationRequest {
    try {
      return parseProjectConversationAssociationRequest({
        action: context.action,
        input: context.input,
      });
    } catch (cause) {
      throw new ApplicationError(
        "validation",
        "project_conversation_association_invalid",
        { cause },
      );
    }
  }
  #dispatch(
    actor: ActorContext,
    request:
      | ProjectConversationsUiActionRequest
      | ProjectConversationAssociationRequest,
    authority: ProjectConversationCommitAuthority,
    context?: PluginUiActionContext,
  ) {
    const service = this.#input.service;
    if (
      context !== undefined &&
      request.action === actions.createConversation &&
      this.#input.nativeWorkspace !== undefined
    )
      return createNativeProvisionedProjectConversation({
        context,
        authority,
        service,
        provisioning: this.#input.nativeWorkspace,
      });
    if (
      context !== undefined &&
      this.#input.projectOwnership === "plugin-project-v1" &&
      [
        actions.createConversation,
        actions.listConversations,
        actions.openConversation,
        actions.refreshSource,
        actions.setState,
      ].includes(request.action as never)
    )
      return service.metadataFromPluginUi(context, authority);
    switch (request.action) {
      case associationActions.inspect:
      case associationActions.attach:
        return service.associateConversation(actor, request, authority);
      case actions.getBinding:
        return service.getBinding(actor, request.input, authority);
      case actions.listConversations:
        return service.listConversations(actor, request.input, authority);
      case actions.createConversation:
        return service.createConversation(actor, request.input, authority);
      case actions.openConversation:
        return service.openConversation(actor, request.input, authority);
      case actions.refreshSource:
        return service.refreshSource(actor, request.input, authority);
      case actions.setState:
        return service.setState(actor, request.input, authority);
      case actions.startStage:
        return service.startStage(actor, request.input, authority);
    }
  }
  async #binding(actor: ActorContext, threadId: string) {
    await this.#input.requests.assertCurrent();
    return this.#input.conversations.loadBinding({
      actor,
      profileId: this.#input.requests.currentScope().profileId,
      threadId,
    });
  }
  /** Internal current-owner issuance; it creates no UI context and still verifies real Node actions for execution. */
  issuePlanConversationAuthority(
    actor: ActorContext,
    installation: ProjectConversationInstallation,
    purpose: "metadata" | "execute",
  ): Promise<ProjectConversationCommitAuthority> {
    return this.#track(() => this.#issue(actor, installation, purpose));
  }
  async #issue(
    actor: ActorContext,
    expected: ProjectConversationInstallation,
    purpose: "metadata" | "execute" | "association" = "metadata",
  ): Promise<ProjectConversationCommitAuthority> {
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
          entry.service === "crewon.project-conversations" &&
          entry.apiVersion === "1",
      ) ||
      (purpose === "association" &&
        !candidate.descriptor.requires.some(
          (entry) =>
            entry.service === "crewon.project-conversation-association" &&
            entry.apiVersion === "1",
        ))
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
        purpose === "execute" &&
        (await this.#input.authorizePackage(
          { actor, scope, candidate: checked, purpose: "submit" },
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
    if (purpose === "execute") {
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
              { actor, scope, candidate: actual, purpose: "submit" },
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
      version: "crewon.project-conversation-commit.v1",
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
function same(a: unknown, b: unknown): boolean {
  return extensionCanonicalJson(a) === extensionCanonicalJson(b);
}
function fingerprint(context: PluginUiActionContext): string {
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
    "project_conversation_authority_changed",
  );
}
function unavailable(): never {
  throw new ApplicationError("conflict", "project_conversation_unavailable");
}
