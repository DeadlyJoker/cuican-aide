import {
  ApplicationError,
  captureProjectFoundationRunCommitTransaction,
  isProjectFoundationApplicationService,
  parseProjectToolInstallationPin,
  ProjectFoundationApplicationService,
  projectFoundationRunMutationCommand,
  type ActorContext,
  type CreativeProjectAuthorizationPort,
  type PluginInstallationStore,
  type ProjectConversationStore,
  type ProjectFoundationCommitAuthority,
  type ProjectFoundationRunAdmissionStore,
  type RunStore,
} from "@crewon/application";
import {
  assertProjectFoundationRunFoundation,
  assertProjectFoundationToolRequest,
  extensionCanonicalJson,
  extensionToolName,
  parsePluginTaskAdmission,
  parseProjectConversationBinding,
  parseProjectFoundationRunAdmission,
  parseProjectStageRunAdmission,
  validateCreativeProjectActor,
  type ExtensionManifest,
  type PluginTaskAdmission,
  type ProjectFoundation,
  type ProjectFoundationRunAdmission,
  type ProjectStageRunAdmission,
} from "@crewon/domain";
import {
  CREWON_PROJECT_FOUNDATION_TOOLS_API_VERSION,
  CREWON_PROJECT_FOUNDATION_TOOLS_SERVICE,
  PROJECT_FOUNDATION_TOOL_OPERATIONS,
  PROJECT_FOUNDATION_TOOL_RESPONSE_LIMITS,
  projectFoundationToolsCodec,
  type PluginProjectFoundationToolsService,
  type ProjectFoundationToolsMethod,
  type ProjectFoundationToolsRequest,
} from "@crewon/contracts/project-foundation-tools";
import type { PluginHostService } from "@crewon/plugin-host";
import type { PluginToolRuntimeContext } from "@crewon/plugin-sdk/node";
import type { ToolExecutionCommand } from "@crewon/tool-broker";
import type {
  ProjectToolsAuthorizationInvocation,
  ProjectToolsDispatchInvocation,
} from "./project-tools-service-owner.ts";
import { assertWorkerToolDispatchEvidence } from "./worker-tool-dispatch-authority.ts";
import { captureProjectFoundationRuntimeAdmission } from "./project-foundation-runtime-scope.ts";
import {
  foundationOwnerBound as bound,
  foundationOwnerData as data,
  foundationOwnerDenied as denied,
  foundationOwnerDigester as sha,
  foundationOwnerNativeRecord,
} from "./project-foundation-owner-support.ts";
import {
  projectFoundationToolChapter,
  projectFoundationToolFoundation,
  projectFoundationToolProposal,
  projectFoundationToolScope,
  projectFoundationToolSource,
  projectFoundationToolTextPage,
} from "./project-foundation-tools-service-projection.ts";

export type ProjectFoundationToolsServiceOwnerDependencies = Readonly<{
  context: PluginToolRuntimeContext;
  admission: PluginTaskAdmission;
  stageAdmission: ProjectStageRunAdmission;
  foundationAdmission: ProjectFoundationRunAdmission;
  tools: ExtensionManifest["tools"];
  foundations: ProjectFoundationApplicationService;
  foundationRuns: ProjectFoundationRunAdmissionStore;
  conversations: Pick<ProjectConversationStore, "loadBinding">;
  runs: Pick<RunStore, "loadRunInSpace">;
  installations: Pick<PluginInstallationStore, "loadSelection" | "loadPackage">;
  authorization: CreativeProjectAuthorizationPort;
  resolveActor(
    owner: Readonly<{ tenantId: string; spaceId: string; actorId: string }>,
    signal?: AbortSignal,
  ): Promise<ActorContext | null>;
  /** Independent actual deployment authorization. Old text/UI grants do not substitute. */
  authorizeFoundationService(signal: AbortSignal): Promise<void>;
  authorizeCurrent(
    invocation: ProjectToolsAuthorizationInvocation,
  ): Promise<void>;
  /** External policy only; must never borrow the committing Store's pool. */
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

/** Original Worker dispatch is the only entry. Setup and public scope data grant no authority. */
export class ProjectFoundationToolsServiceOwner {
  readonly #d: ProjectFoundationToolsServiceOwnerDependencies;
  readonly #foundation: ProjectFoundationRunAdmission;
  readonly #stage: ProjectStageRunAdmission;
  readonly #service: PluginProjectFoundationToolsService;
  readonly #invocations = new WeakMap<object, Invocation>();
  readonly #active = new Set<Invocation>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #abort = new AbortController();
  #closed = false;
  #closing: Promise<void> | undefined;

  constructor(input: ProjectFoundationToolsServiceOwnerDependencies) {
    if (!isProjectFoundationApplicationService(input.foundations)) denied();
    const admission = parsePluginTaskAdmission(input.admission);
    this.#stage = parseProjectStageRunAdmission(input.stageAdmission, sha);
    this.#foundation = captureProjectFoundationRuntimeAdmission({
      ...input,
      admission,
    });
    this.#d = Object.freeze({
      ...input,
      admission,
      stageAdmission: this.#stage,
      foundationAdmission: this.#foundation,
      resolveActor: bound<
        ProjectFoundationToolsServiceOwnerDependencies["resolveActor"]
      >(input, "resolveActor"),
      authorizeFoundationService: bound<
        ProjectFoundationToolsServiceOwnerDependencies["authorizeFoundationService"]
      >(input, "authorizeFoundationService"),
      authorizeCurrent: bound<
        ProjectFoundationToolsServiceOwnerDependencies["authorizeCurrent"]
      >(input, "authorizeCurrent"),
      authorizeTransaction: bound<
        ProjectFoundationToolsServiceOwnerDependencies["authorizeTransaction"]
      >(input, "authorizeTransaction"),
      assertActive: bound<
        ProjectFoundationToolsServiceOwnerDependencies["assertActive"]
      >(input, "assertActive"),
      foundationRuns: Object.freeze({
        readRequiredFoundationDigest: bound<
          ProjectFoundationRunAdmissionStore["readRequiredFoundationDigest"]
        >(input.foundationRuns, "readRequiredFoundationDigest"),
        loadFoundationRunAdmission: bound<
          ProjectFoundationRunAdmissionStore["loadFoundationRunAdmission"]
        >(input.foundationRuns, "loadFoundationRunAdmission"),
      }),
      conversations: Object.freeze({
        loadBinding: bound<ProjectConversationStore["loadBinding"]>(
          input.conversations,
          "loadBinding",
        ),
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
    });
    this.#service = Object.freeze(
      Object.fromEntries(
        Object.keys(PROJECT_FOUNDATION_TOOL_OPERATIONS).map((method) => [
          method,
          (input: unknown) =>
            this.#call(method as ProjectFoundationToolsMethod, input),
        ]),
      ),
    ) as PluginProjectFoundationToolsService;
  }

  hostService(): PluginHostService {
    return Object.freeze({
      service: CREWON_PROJECT_FOUNDATION_TOOLS_SERVICE,
      apiVersion: CREWON_PROJECT_FOUNDATION_TOOLS_API_VERSION,
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
    this.#abort.abort(
      new Error("plugin_project_foundation_tools_owner_closed"),
    );
    this.#closing = (async () => {
      while (this.#active.size > 0 || this.#pending.size > 0) {
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

  #dispatch(command: ToolExecutionCommand): ProjectFoundationToolsRequest {
    const method = (
      Object.keys(
        PROJECT_FOUNDATION_TOOL_OPERATIONS,
      ) as ProjectFoundationToolsMethod[]
    ).find(
      (method) =>
        command.name ===
        extensionToolName(
          this.#d.admission.pluginId,
          PROJECT_FOUNDATION_TOOL_OPERATIONS[method],
        ),
    );
    if (method === undefined) denied();
    const operation = PROJECT_FOUNDATION_TOOL_OPERATIONS[method],
      write = method === "saveProposal",
      definition = this.#d.tools.find((tool) => tool.operationId === operation),
      action = command.actionIntent;
    if (
      definition === undefined ||
      definition.adapterId !== CREWON_PROJECT_FOUNDATION_TOOLS_SERVICE ||
      definition.capability !== (write ? "project.write" : "project.read") ||
      definition.effect !== (write ? "mutation" : "readOnly") ||
      definition.recovery !== (write ? "reconcilable" : "replaySafe") ||
      action.capability !== definition.capability ||
      action.effect !== definition.effect ||
      action.recovery !== definition.recovery ||
      action.executionTarget.kind !== "control" ||
      action.policySnapshotId !== this.#d.context.target.policySnapshotId ||
      action.workspaceBindingId !== this.#d.context.target.workspaceBindingId ||
      action.limits.maxOutputBytes <
        PROJECT_FOUNDATION_TOOL_RESPONSE_LIMITS[operation]
    )
      denied();
    const parsed = projectFoundationToolsCodec.parseRequest({
      operation,
      request: JSON.parse(command.input),
    });
    assertProjectFoundationToolRequest(
      this.#foundation,
      operation,
      parsed.request,
    );
    return parsed;
  }

  #call(
    method: ProjectFoundationToolsMethod,
    input: unknown,
  ): Promise<unknown> {
    try {
      const v = data(input, ["command", "request"]),
        command = v.command;
      if (command === null || typeof command !== "object") denied();
      const i = this.#invocations.get(command);
      if (!i || i.method === "cancel" || i.pending.size >= 64) denied();
      this.#check(i);
      foundationOwnerNativeRecord(v.request);
      const original = this.#dispatch(i.command),
        parsed = projectFoundationToolsCodec.parseRequest({
          operation: PROJECT_FOUNDATION_TOOL_OPERATIONS[method],
          request: v.request,
        });
      if (extensionCanonicalJson(parsed) !== extensionCanonicalJson(original))
        denied();
      const task = this.#execute(parsed, i);
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

  async #execute(
    request: ProjectFoundationToolsRequest,
    i: Invocation,
  ): Promise<unknown> {
    const signal = AbortSignal.any([i.signal, this.#abort.signal]),
      operation = {
        ...i,
        signal,
        operationId: request.operation,
        projectId: this.#foundation.projectId,
      },
      write = request.operation === "foundation_proposal_save";
    await this.#authorizeCurrent(operation);
    this.#check(i);
    const actor = await this.#actor(signal),
      run = await this.#run(i);
    await this.#policy(actor, write);
    let foundation: ProjectFoundation | null = null;
    if (write) await this.#identityQualification(actor, i);
    else foundation = await this.#qualification(actor, i);
    const installation = this.#foundation.installation,
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
    this.#check(i);
    if (
      selection === null ||
      pkg === null ||
      selection.state !== "enabled" ||
      selection.revision !== installation.selectionRevision ||
      selection.selectedPackageDigest !== installation.packageDigest ||
      pkg.version !== installation.version ||
      pkg.packageDigest !== installation.packageDigest ||
      (
        ["tenantId", "spaceId", "profileId", "pluginId", "publisherId"] as const
      ).some(
        (key) =>
          selection[key] !== installation[key] ||
          pkg[key] !== installation[key],
      )
    )
      denied();
    let value: unknown;
    if (request.operation === "foundation_proposal_save") {
      const current = async () => {
          this.#check(i);
          signal.throwIfAborted();
          if ((await this.#d.authorizeFoundationService(signal)) !== undefined)
            denied();
          if ((await this.#d.authorizeTransaction(operation)) !== undefined)
            denied();
          await this.#actor(signal);
          await this.#policy(actor, true);
          this.#check(i);
        },
        evidence = this.#check(i),
        transaction = captureProjectFoundationRunCommitTransaction({
          version: "crewon.project-foundation-run-commit.v1",
          actor,
          run,
          receipt: evidence.receipt,
          claim: evidence.claim,
          commandInput: i.command.input,
          operationId: "foundation_proposal_save",
          installation: parseProjectToolInstallationPin(installation),
          admission: this.#d.admission,
          projectStageAdmission: this.#stage,
          foundationAdmission: this.#foundation,
          selection,
          package: pkg,
          assertCurrent: current,
        });
      const authority: ProjectFoundationCommitAuthority = Object.freeze({
        runTransaction: transaction,
        assertActive: () => {
          this.#check(i);
        },
        assertCurrent: async () => {
          await this.#authorizeCurrent(operation);
          await current();
        },
      });
      const result =
        await ProjectFoundationApplicationService.prototype.saveProposal.call(
          this.#d.foundations,
          actor,
          projectFoundationRunMutationCommand(transaction, sha),
          { authority },
        );
      if (result.proposal === null)
        throw new Error(
          "plugin_project_foundation_tools_commit_result_invalid",
        );
      value = {
        kind: "save-proposal",
        disposition: result.disposition,
        foundationRevision: result.foundation.revision,
        proposal: projectFoundationToolProposal(result.proposal),
      };
      // The actual Store returned committed/replayed facts. No late policy/installation read follows COMMIT.
    } else if (request.operation === "foundation_scope") {
      value = { scope: projectFoundationToolScope(this.#foundation) };
    } else if (request.operation === "foundation_read") {
      if (foundation === null) denied();
      value = { foundation: projectFoundationToolFoundation(foundation) };
    } else if (request.operation === "foundation_source") {
      const source =
        await ProjectFoundationApplicationService.prototype.getSource.call(
          this.#d.foundations,
          actor,
          {
            projectId: request.request.projectId,
            sourceRevision: request.request.sourceRevision,
          },
        );
      if (source.digest !== request.request.sourceDigest) denied();
      value = { source: projectFoundationToolSource(source) };
    } else if (request.operation === "foundation_source_page") {
      const page =
        await ProjectFoundationApplicationService.prototype.readSourcePage.call(
          this.#d.foundations,
          actor,
          request.request,
        );
      const source =
        await ProjectFoundationApplicationService.prototype.getSource.call(
          this.#d.foundations,
          actor,
          {
            projectId: request.request.projectId,
            sourceRevision: request.request.sourceRevision,
          },
        );
      value = {
        sourceRevision: request.request.sourceRevision,
        sourceDigest: request.request.sourceDigest,
        page: {
          startOffset: page.startOffset,
          endOffset: page.endOffset,
          content: page.content,
          nextOffset: page.nextOffset,
          characterLength: source.characterLength,
        },
      };
    } else if (request.operation === "foundation_chapters") {
      const page =
        await ProjectFoundationApplicationService.prototype.listSourceChapters.call(
          this.#d.foundations,
          actor,
          {
            ...request.request,
            afterStartOffset: request.request.afterStartOffset ?? null,
          },
        );
      value = {
        chapters: page.chapters.map(projectFoundationToolChapter),
        nextStartOffset: page.nextStartOffset,
      };
    } else if (request.operation === "foundation_proposal") {
      try {
        const proposal =
          await ProjectFoundationApplicationService.prototype.getProposal.call(
            this.#d.foundations,
            actor,
            {
              projectId: request.request.projectId,
              proposalRevision: request.request.proposalRevision,
            },
          );
        if (proposal.contentDigest !== request.request.proposalDigest) denied();
        value = {
          proposal: projectFoundationToolProposal(proposal),
          page: projectFoundationToolTextPage(
            proposal.text,
            request.request.startOffset,
            request.request.limit,
          ),
        };
      } catch (error) {
        if (
          !(error instanceof ApplicationError) ||
          error.category !== "notFound" ||
          error.code !== "project_foundation_proposal_not_found"
        )
          throw error;
        value = { proposal: null, page: null };
      }
    } else {
      const page =
        await ProjectFoundationApplicationService.prototype.listProposals.call(
          this.#d.foundations,
          actor,
          request.request,
        );
      value = {
        proposals: page.proposals.map(projectFoundationToolProposal),
        nextRevision: page.nextRevision,
      };
    }
    if (!write) {
      await this.#authorizeCurrent(operation);
      await this.#actor(signal);
      await this.#run(i);
      await this.#policy(actor, false);
      await this.#qualification(actor, i);
      this.#check(i);
    }
    return projectFoundationToolsCodec.parseResponse(value, request);
  }

  async #authorizeCurrent(
    operation: ProjectToolsAuthorizationInvocation,
  ): Promise<void> {
    if (
      (await this.#d.authorizeFoundationService(operation.signal)) !== undefined
    )
      denied();
    if ((await this.#d.authorizeCurrent(operation)) !== undefined) denied();
  }

  async #qualification(actor: ActorContext, i: Invocation) {
    await this.#identityQualification(actor, i);
    const f = this.#foundation;
    const foundation =
      await ProjectFoundationApplicationService.prototype.getFoundation.call(
        this.#d.foundations,
        actor,
        { projectId: f.projectId },
      );
    if (foundation === null) denied();
    assertProjectFoundationRunFoundation(f, foundation, sha);
    this.#check(i);
    return foundation;
  }

  /** Replay publication requires the same actual Run/binding; captured pointers gate only fresh writes in Store. */
  async #identityQualification(actor: ActorContext, i: Invocation) {
    const f = this.#foundation,
      locator = {
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        runId: f.runId,
      },
      required =
        await this.#d.foundationRuns.readRequiredFoundationDigest(locator),
      raw = await this.#d.foundationRuns.loadFoundationRunAdmission(locator);
    if (
      raw === null ||
      required !== f.contentDigest ||
      extensionCanonicalJson(parseProjectFoundationRunAdmission(raw, sha)) !==
        extensionCanonicalJson(f)
    )
      denied();
    const rawBinding = await this.#d.conversations.loadBinding({
      actor,
      profileId: f.installation.profileId,
      threadId: f.threadId,
    });
    if (rawBinding === null) denied();
    const binding = parseProjectConversationBinding(rawBinding, sha);
    if (
      binding.state !== "active" ||
      binding.bindingId !== f.bindingId ||
      binding.revision !== f.bindingRevision ||
      binding.projectId !== f.projectId ||
      binding.workspaceId !== f.workspaceId ||
      extensionCanonicalJson(binding.owner) !==
        extensionCanonicalJson(f.actor) ||
      extensionCanonicalJson(binding.currentInstallation) !==
        extensionCanonicalJson(f.installation)
    )
      denied();
    this.#check(i);
  }

  async #policy(actor: ActorContext, write: boolean): Promise<void> {
    const result = await this.#d.authorization.authorize({
      actor,
      action: write ? "creativeProject:write" : "creativeProject:read",
      resource: {
        kind: "creativeProject",
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        projectId: this.#foundation.projectId,
      },
    });
    if (result.outcome !== "allow") denied();
  }

  async #actor(signal: AbortSignal): Promise<ActorContext> {
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

  async #run(i: Invocation) {
    const a = this.#d.admission,
      run = await this.#d.runs.loadRunInSpace({
        tenantId: a.tenantId,
        spaceId: a.spaceId,
        runId: a.runId,
      });
    this.#check(i);
    if (
      run === null ||
      run.runId !== a.runId ||
      run.tenantId !== a.tenantId ||
      run.spaceId !== a.spaceId ||
      run.threadId !== a.threadId ||
      run.createdByActorId !== a.actorId ||
      run.cancelRequested ||
      (run.status !== "running" &&
        !(
          run.status === "reconciling" &&
          this.#check(i).receipt.status === "unknownOutcome" &&
          run.reconciliationReceiptId === this.#check(i).receipt.receiptId
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
