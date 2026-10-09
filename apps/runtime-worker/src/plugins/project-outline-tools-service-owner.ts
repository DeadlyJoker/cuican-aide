import {
  captureProjectOutlineRunCommitTransaction,
  parseProjectToolInstallationPin,
  projectOutlineRunMutationCommand,
  ProjectStructuredOutlineApplicationService,
  type ActorContext,
  type CreativeProjectAuthorizationPort,
  type CreativeProjectCommitAuthority,
  type PluginInstallationStore,
  type ProjectConversationStore,
  type ProjectFoundationStore,
  type RunStore,
} from "@crewon/application";
import {
  assertProjectStageToolRequest,
  extensionCanonicalJson,
  extensionToolName,
  parsePluginTaskAdmission,
  parseProjectConversationBinding,
  parseProjectStageRunAdmission,
  validateCreativeProjectActor,
  validateProjectFoundation,
  type ExtensionManifest,
  type PluginTaskAdmission,
  type ProjectStageRunAdmission,
} from "@crewon/domain";
import {
  CREWON_PROJECT_OUTLINE_TOOLS_API_VERSION,
  CREWON_PROJECT_OUTLINE_TOOLS_SERVICE,
  MAX_PROJECT_OUTLINE_TOOL_INPUT_BYTES,
  MAX_PROJECT_OUTLINE_TOOL_OUTPUT_BYTES,
  parseProjectOutlineToolRequest,
  parseProjectOutlineToolCommand,
  parseProjectOutlineToolContextRequest,
  parseProjectOutlineToolContext,
  MAX_PROJECT_OUTLINE_CONTEXT_OUTPUT_BYTES,
  type ProjectOutlineToolContextRequest,
  type ProjectOutlineToolContext,
  type ProjectOutlineToolResult,
  parseProjectOutlineToolResult,
  type PluginProjectOutlineToolsService,
  type ProjectOutlineToolRequest,
} from "@crewon/contracts/project-outline-tools";
import type { PluginHostService } from "@crewon/plugin-host";
import type { PluginToolRuntimeContext } from "@crewon/plugin-sdk/node";
import type { ToolExecutionCommand } from "@crewon/tool-broker";
import type {
  ProjectToolsAuthorizationInvocation,
  ProjectToolsDispatchInvocation,
} from "./project-tools-service-owner.ts";
import { assertWorkerToolDispatchEvidence } from "./worker-tool-dispatch-authority.ts";
import {
  foundationOwnerBound as bound,
  foundationOwnerData as data,
  foundationOwnerDigester as sha,
  foundationOwnerNativeRecord,
} from "./project-foundation-owner-support.ts";

export type ProjectOutlineToolsServiceOwnerDependencies = Readonly<{
  context: PluginToolRuntimeContext;
  admission: PluginTaskAdmission;
  stageAdmission: ProjectStageRunAdmission;
  tools: ExtensionManifest["tools"];
  outlines: ProjectStructuredOutlineApplicationService;
  foundations: Pick<ProjectFoundationStore, "loadFoundation">;
  conversations: Pick<
    ProjectConversationStore,
    "loadBinding" | "loadStageAdmission" | "readRequiredStageDigest"
  >;
  runs: Pick<RunStore, "loadRunInSpace">;
  installations: Pick<PluginInstallationStore, "loadSelection" | "loadPackage">;
  authorization: CreativeProjectAuthorizationPort;
  resolveActor(
    owner: Readonly<{ tenantId: string; spaceId: string; actorId: string }>,
    signal?: AbortSignal,
  ): Promise<ActorContext | null>;
  /** Independently declared deployment grant; legacy text and manual UI grants cannot substitute. */
  authorizeOutlineService(signal: AbortSignal): Promise<void>;
  authorizeCurrent(
    invocation: ProjectToolsAuthorizationInvocation,
  ): Promise<void>;
  /** External policy only: never borrow the committing Store connection. */
  authorizeTransaction(
    invocation: ProjectToolsAuthorizationInvocation,
  ): Promise<void>;
  assertActive(): void;
  now?: () => Date;
}>;
type Invocation = ProjectToolsDispatchInvocation & {
  live: boolean;
  pending: Set<Promise<unknown>>;
};

/** A live original outline Tool can append a candidate, never adopt or lock it. */
export class ProjectOutlineToolsServiceOwner {
  readonly #d: ProjectOutlineToolsServiceOwnerDependencies;
  readonly #stage: ProjectStageRunAdmission;
  readonly #service: PluginProjectOutlineToolsService;
  readonly #invocations = new WeakMap<object, Invocation>();
  readonly #active = new Set<Invocation>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #abort = new AbortController();
  #closed = false;
  #closing: Promise<void> | undefined;

  constructor(input: ProjectOutlineToolsServiceOwnerDependencies) {
    foundationOwnerNativeRecord(input);
    if (!(input.outlines instanceof ProjectStructuredOutlineApplicationService))
      denied();
    const admission = parsePluginTaskAdmission(input.admission);
    this.#stage = parseProjectStageRunAdmission(input.stageAdmission, sha);
    const stage = this.#stage,
      context = input.context;
    if (
      stage.stage.kind !== "outline" ||
      admission.action !== "project.execute" ||
      context.run.source !== null ||
      stage.runId !== admission.runId ||
      stage.threadId !== admission.threadId ||
      stage.runId !== context.run.runId ||
      stage.threadId !== context.run.threadId ||
      stage.userContentDigest !== context.run.inputDigest ||
      stage.extensionBindingDigest !== context.run.bindingDigest ||
      stage.extensionBindingDigest !== admission.extensionBindingDigest ||
      stage.requestDigest !== admission.requestDigest ||
      stage.idempotencyKey !== admission.idempotencyKey ||
      stage.pluginTaskAdmissionDigest !==
        sha.sha256(extensionCanonicalJson(admission)) ||
      (Object.keys(stage.actor) as (keyof typeof stage.actor)[]).some(
        (key) => stage.actor[key] !== admission[key],
      ) ||
      (
        Object.keys(stage.installation) as (keyof typeof stage.installation)[]
      ).some((key) => stage.installation[key] !== admission[key]) ||
      (["pluginId", "version", "packageDigest"] as const).some(
        (key) => context.identity[key] !== stage.installation[key],
      )
    )
      denied();
    this.#d = Object.freeze({
      ...input,
      admission,
      stageAdmission: stage,
      resolveActor: bound<
        ProjectOutlineToolsServiceOwnerDependencies["resolveActor"]
      >(input, "resolveActor"),
      authorizeOutlineService: bound<
        ProjectOutlineToolsServiceOwnerDependencies["authorizeOutlineService"]
      >(input, "authorizeOutlineService"),
      authorizeCurrent: bound<
        ProjectOutlineToolsServiceOwnerDependencies["authorizeCurrent"]
      >(input, "authorizeCurrent"),
      authorizeTransaction: bound<
        ProjectOutlineToolsServiceOwnerDependencies["authorizeTransaction"]
      >(input, "authorizeTransaction"),
      assertActive: bound<
        ProjectOutlineToolsServiceOwnerDependencies["assertActive"]
      >(input, "assertActive"),
      conversations: Object.freeze({
        loadBinding: bound<ProjectConversationStore["loadBinding"]>(
          input.conversations,
          "loadBinding",
        ),
        loadStageAdmission: bound<
          ProjectConversationStore["loadStageAdmission"]
        >(input.conversations, "loadStageAdmission"),
        readRequiredStageDigest: bound<
          ProjectConversationStore["readRequiredStageDigest"]
        >(input.conversations, "readRequiredStageDigest"),
      }),
      runs: Object.freeze({
        loadRunInSpace: bound<RunStore["loadRunInSpace"]>(
          input.runs,
          "loadRunInSpace",
        ),
      }),
      installations: Object.freeze({
        loadSelection: bound<PluginInstallationStore["loadSelection"]>(
          input.installations,
          "loadSelection",
        ),
        loadPackage: bound<PluginInstallationStore["loadPackage"]>(
          input.installations,
          "loadPackage",
        ),
      }),
      authorization: Object.freeze({
        authorize: bound<CreativeProjectAuthorizationPort["authorize"]>(
          input.authorization,
          "authorize",
        ),
      }),
      foundations: Object.freeze({
        loadFoundation: bound<ProjectFoundationStore["loadFoundation"]>(
          input.foundations,
          "loadFoundation",
        ),
      }),
    });
    this.#service = Object.freeze({
      saveCandidate: (input) => this.#call("outline_change", input),
      getContext: (input) => this.#call("outline_context", input),
    });
  }
  hostService(): PluginHostService {
    return Object.freeze({
      service: CREWON_PROJECT_OUTLINE_TOOLS_SERVICE,
      apiVersion: CREWON_PROJECT_OUTLINE_TOOLS_API_VERSION,
      value: this.#service,
      bindForPlugin: (identity, lifetime) => {
        this.#open();
        if (
          (["pluginId", "version", "packageDigest"] as const).some(
            (key) => identity[key] !== this.#d.context.identity[key],
          )
        )
          denied();
        lifetime.onDispose(() => this.close());
        return this.#service;
      },
    });
  }
  async withInvocation<T>(
    input: ProjectToolsDispatchInvocation,
    delegate: () => Promise<T>,
  ): Promise<T> {
    this.#open();
    assertWorkerToolDispatchEvidence(input);
    if (
      input.command.runId !== this.#d.admission.runId ||
      this.#invocations.has(input.command) ||
      this.#active.size >= 64
    )
      denied();
    const invocation: Invocation = { ...input, live: true, pending: new Set() };
    this.#invocations.set(input.command, invocation);
    this.#active.add(invocation);
    const task = Promise.resolve().then(() => {
      this.#check(invocation);
      this.#dispatch(input.command);
      return delegate();
    });
    this.#pending.add(task);
    try {
      return await task;
    } finally {
      while (invocation.pending.size > 0)
        await Promise.allSettled([...invocation.pending]);
      invocation.live = false;
      this.#invocations.delete(input.command);
      this.#active.delete(invocation);
      this.#pending.delete(task);
    }
  }
  canRetire(): boolean {
    return this.#active.size === 0 && this.#pending.size === 0;
  }
  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    this.#closed = true;
    this.#abort.abort(new Error("plugin_project_outline_tools_owner_closed"));
    this.#closing = (async () => {
      while (!this.canRetire()) {
        await Promise.allSettled([...this.#pending]);
        await Promise.allSettled(
          [...this.#active].flatMap((value) => [...value.pending]),
        );
      }
    })();
    return this.#closing;
  }
  #open(): void {
    if (this.#closed || this.#d.assertActive() !== undefined) denied();
  }
  #check(i: Invocation) {
    this.#open();
    if (!i.live || this.#invocations.get(i.command) !== i) denied();
    const evidence = assertWorkerToolDispatchEvidence(i);
    if (
      Math.min(
        Date.parse(evidence.claim.lease.expiresAt),
        Date.parse(i.command.executionLease.expiresAt),
      ) <= (this.#d.now?.() ?? new Date()).getTime()
    )
      denied();
    return evidence;
  }
  #dispatch(command: ToolExecutionCommand) {
    const read =
        command.name ===
        extensionToolName(this.#d.admission.pluginId, "outline_context"),
      operationId = read ? "outline_context" : "outline_change";
    const definition = this.#d.tools.find(
        (tool) => tool.operationId === operationId,
      ),
      action = command.actionIntent;
    if (
      definition === undefined ||
      command.name !==
        extensionToolName(this.#d.admission.pluginId, operationId) ||
      definition.adapterId !== CREWON_PROJECT_OUTLINE_TOOLS_SERVICE ||
      definition.capability !== (read ? "project.read" : "project.write") ||
      definition.effect !== (read ? "readOnly" : "mutation") ||
      definition.recovery !== (read ? "replaySafe" : "reconcilable") ||
      action.capability !== definition.capability ||
      action.effect !== definition.effect ||
      action.recovery !== definition.recovery ||
      action.executionTarget.kind !== "control" ||
      action.policySnapshotId !== this.#d.context.target.policySnapshotId ||
      action.workspaceBindingId !== this.#d.context.target.workspaceBindingId ||
      action.limits.maxOutputBytes <
        (read
          ? MAX_PROJECT_OUTLINE_CONTEXT_OUTPUT_BYTES
          : MAX_PROJECT_OUTLINE_TOOL_OUTPUT_BYTES) ||
      Buffer.byteLength(command.input, "utf8") >
        MAX_PROJECT_OUTLINE_TOOL_INPUT_BYTES
    )
      denied();
    if (read) {
      const request = parseProjectOutlineToolContextRequest(
        JSON.parse(command.input),
      );
      if (request.projectId !== this.#stage.projectId) denied();
      return { operation: "outline_context" as const, request };
    }
    const parsed = parseProjectOutlineToolCommand(JSON.parse(command.input));
    const { expectedFoundationRevision: _foundation, ...mutation } = parsed;
    assertProjectStageToolRequest(this.#stage, "outline_save", mutation);
    return { operation: "outline_change" as const, request: parsed };
  }
  #call(
    operation: "outline_change",
    input: unknown,
  ): Promise<ProjectOutlineToolResult>;
  #call(
    operation: "outline_context",
    input: unknown,
  ): Promise<ProjectOutlineToolContext>;
  #call(
    operation: "outline_change" | "outline_context",
    input: unknown,
  ): Promise<ProjectOutlineToolResult | ProjectOutlineToolContext> {
    try {
      const v = data(input, ["command", "request"]),
        command = v.command;
      if (command === null || typeof command !== "object") denied();
      const i = this.#invocations.get(command);
      if (!i || i.method === "cancel" || i.pending.size >= 64) denied();
      this.#check(i);
      foundationOwnerNativeRecord(v.request);
      const parsed = this.#dispatch(i.command),
        request =
          operation === "outline_change"
            ? parseProjectOutlineToolRequest(v.request)
            : parseProjectOutlineToolContextRequest(v.request);
      if (
        parsed.operation !== operation ||
        extensionCanonicalJson(request) !==
          extensionCanonicalJson(parsed.request)
      )
        denied();
      const task =
        parsed.operation === "outline_change"
          ? this.#execute(parsed.request, i)
          : this.#readContext(parsed.request, i);
      i.pending.add(task);
      this.#pending.add(task);
      void task
        .finally(() => {
          i.pending.delete(task);
          this.#pending.delete(task);
        })
        .catch(() => {});
      return task;
    } catch (error) {
      return Promise.reject(error);
    }
  }
  async #readContext(request: ProjectOutlineToolContextRequest, i: Invocation) {
    const signal = AbortSignal.any([i.signal, this.#abort.signal]),
      operation = {
        ...i,
        signal,
        operationId: "outline_context",
        projectId: this.#stage.projectId,
      };
    await this.#authorizeCurrent(operation);
    const actor = await this.#actor(signal);
    await this.#run(i);
    await this.#identity(actor, i);
    await this.#policy(actor, false);
    const raw = await this.#d.foundations.loadFoundation({
      owner: {
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        principalId: actor.principalId,
      },
      projectId: request.projectId,
    });
    if (raw === null)
      throw new Error("plugin_project_outline_foundation_missing");
    const foundation = validateProjectFoundation(raw);
    if (
      foundation.projectId !== request.projectId ||
      foundation.tenantId !== actor.tenantId ||
      foundation.spaceId !== actor.spaceId ||
      foundation.ownerPrincipalId !== actor.principalId ||
      (request.expectedFoundationRevision !== 0 &&
        foundation.revision !== request.expectedFoundationRevision)
    )
      denied();
    // Existing Application authorizes and validates the original project/outline identity. No write is performed.
    await ProjectStructuredOutlineApplicationService.prototype.getOutline.call(
      this.#d.outlines,
      actor,
      { projectId: request.projectId },
    );
    const parameters = extensionCanonicalJson(foundation.parameters),
      points = Array.from(parameters),
      end = Math.min(request.offset + 1024, points.length);
    if (request.offset > points.length) denied();
    const stage = this.#stage.stage;
    if (stage.kind !== "outline") denied();
    const result = parseProjectOutlineToolContext(request, {
      context: {
        projectId: request.projectId,
        briefRevision: stage.briefRevision,
        foundationRevision: foundation.revision,
        parametersRevision: foundation.parametersRevision,
        parametersDigest: sha.sha256(parameters),
        origin: foundation.origin,
        source: foundation.source,
        confirmedProposal: foundation.confirmedProposal,
      },
      page: {
        text: points.slice(request.offset, end).join(""),
        offset: request.offset,
        nextOffset: end < points.length ? end : null,
        totalCodePoints: points.length,
      },
    });
    await this.#authorizeCurrent(operation);
    await this.#actor(signal);
    await this.#run(i);
    await this.#identity(actor, i);
    await this.#policy(actor, false);
    const latest = await this.#d.foundations.loadFoundation({
      owner: {
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        principalId: actor.principalId,
      },
      projectId: request.projectId,
    });
    if (
      latest === null ||
      extensionCanonicalJson(validateProjectFoundation(latest)) !==
        extensionCanonicalJson(foundation)
    )
      denied();
    this.#check(i);
    return result;
  }
  async #authorizeCurrent(operation: ProjectToolsAuthorizationInvocation) {
    if (
      (await this.#d.authorizeOutlineService(operation.signal)) !== undefined ||
      (await this.#d.authorizeCurrent(operation)) !== undefined
    )
      denied();
  }
  async #execute(request: ProjectOutlineToolRequest, i: Invocation) {
    const signal = AbortSignal.any([i.signal, this.#abort.signal]),
      operation = {
        ...i,
        signal,
        operationId: "outline_change",
        projectId: this.#stage.projectId,
      };
    await this.#authorizeCurrent(operation);
    this.#check(i);
    const actor = await this.#actor(signal),
      run = await this.#run(i);
    await this.#policy(actor);
    await this.#identity(actor, i);
    const installation = this.#stage.installation,
      scope = {
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        profileId: installation.profileId,
      },
      [selection, pkg] = await Promise.all([
        this.#d.installations.loadSelection({
          scope,
          pluginId: installation.pluginId,
        }),
        this.#d.installations.loadPackage({
          scope,
          packageDigest: installation.packageDigest,
        }),
      ]);
    if (selection === null || pkg === null) denied();
    const current = async () => {
      this.#check(i);
      signal.throwIfAborted();
      if (
        (await this.#d.authorizeOutlineService(signal)) !== undefined ||
        (await this.#d.authorizeTransaction(operation)) !== undefined
      )
        denied();
      await this.#actor(signal);
      await this.#policy(actor);
      this.#check(i);
    };
    const evidence = this.#check(i),
      transaction = captureProjectOutlineRunCommitTransaction({
        version: "crewon.project-outline-run-commit.v2",
        actor,
        run,
        receipt: evidence.receipt,
        claim: evidence.claim,
        commandInput: i.command.input,
        operationId: "outline_change",
        installation: parseProjectToolInstallationPin(installation),
        admission: this.#d.admission,
        projectStageAdmission: this.#stage,
        selection,
        package: pkg,
        assertCurrent: current,
      });
    const authority: CreativeProjectCommitAuthority = Object.freeze({
      outlineRunTransaction: transaction,
      assertActive: () => {
        this.#check(i);
      },
      assertCurrent: async () => {
        await this.#authorizeCurrent(operation);
        await current();
      },
    });
    const result =
      await ProjectStructuredOutlineApplicationService.prototype.saveCandidate.call(
        this.#d.outlines,
        actor,
        projectOutlineRunMutationCommand(transaction, sha),
        { authority },
      );
    if (result.contentRevision === null) denied();
    // COMMIT has returned its durable fact. Never lose that ACK to a late external permission check.
    return parseProjectOutlineToolResult(request, {
      kind: "save-outline",
      disposition: result.disposition,
      projectId: result.artifact.projectId,
      artifactId: result.artifact.artifactId,
      artifactRevision: result.artifact.revision,
      contentRevision: result.contentRevision.contentRevision,
      contentDigest: result.contentRevision.contentDigest,
    });
  }
  async #identity(actor: ActorContext, i: Invocation) {
    const s = this.#stage,
      locator = {
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        runId: s.runId,
      };
    const required =
        await this.#d.conversations.readRequiredStageDigest(locator),
      raw = await this.#d.conversations.loadStageAdmission(locator);
    if (
      raw === null ||
      required !== s.contentDigest ||
      extensionCanonicalJson(parseProjectStageRunAdmission(raw, sha)) !==
        extensionCanonicalJson(s)
    )
      denied();
    const rawBinding = await this.#d.conversations.loadBinding({
      actor,
      profileId: s.installation.profileId,
      threadId: s.threadId,
    });
    if (rawBinding === null) denied();
    const binding = parseProjectConversationBinding(rawBinding, sha);
    if (
      binding.state !== "active" ||
      binding.bindingId !== s.bindingId ||
      binding.revision !== s.bindingRevision ||
      binding.projectId !== s.projectId ||
      binding.workspaceId !== s.workspaceId ||
      extensionCanonicalJson(binding.owner) !==
        extensionCanonicalJson(s.actor) ||
      extensionCanonicalJson(binding.currentInstallation) !==
        extensionCanonicalJson(s.installation)
    )
      denied();
    this.#check(i);
  }
  async #actor(signal: AbortSignal) {
    const a = this.#d.admission,
      raw = await this.#d.resolveActor(
        { tenantId: a.tenantId, spaceId: a.spaceId, actorId: a.actorId },
        signal,
      );
    if (raw === null) denied();
    const actor = validateCreativeProjectActor(raw);
    if (
      (["tenantId", "spaceId", "principalId", "actorId"] as const).some(
        (key) => actor[key] !== a[key],
      )
    )
      denied();
    return actor;
  }
  async #policy(actor: ActorContext, write = true) {
    const result = await this.#d.authorization.authorize({
      actor,
      action: write ? "creativeProject:write" : "creativeProject:read",
      resource: {
        kind: "creativeProject",
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        projectId: this.#stage.projectId,
      },
    });
    if (result.outcome !== "allow") denied();
  }
  async #run(i: Invocation) {
    const a = this.#d.admission,
      run = await this.#d.runs.loadRunInSpace({
        tenantId: a.tenantId,
        spaceId: a.spaceId,
        runId: a.runId,
      });
    const evidence = this.#check(i);
    if (
      run === null ||
      run.runId !== a.runId ||
      run.threadId !== a.threadId ||
      run.tenantId !== a.tenantId ||
      run.spaceId !== a.spaceId ||
      run.createdByActorId !== a.actorId ||
      run.cancelRequested ||
      (run.status !== "running" &&
        !(
          run.status === "reconciling" &&
          evidence.receipt.status === "unknownOutcome" &&
          run.reconciliationReceiptId === evidence.receipt.receiptId
        )) ||
      (
        [
          "authorityId",
          "runtimeGeneration",
          "agentVersionId",
          "policySnapshotId",
          "workspaceBindingId",
        ] as const
      ).some((key) => run[key] !== this.#d.context.target[key])
    )
      denied();
    return run;
  }
}
function denied(): never {
  throw new Error("plugin_project_outline_tools_authority_denied");
}
