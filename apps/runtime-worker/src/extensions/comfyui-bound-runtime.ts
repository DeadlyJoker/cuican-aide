import { createHash } from "node:crypto";
import {
  extensionCanonicalJson,
  parseExtensionConfiguration,
  parseExtensionExecutionTarget,
  parseExtensionRunBinding,
  type ExtensionConfiguration,
  type ExtensionExecutionTarget,
  type ExtensionRunBinding,
} from "@crewon/domain";
import type {
  ExtensionExecutionAccessPort,
  ExtensionRegistration,
  ExtensionStore,
  ExternalOperationStore,
  RunStore,
} from "@crewon/application";
import {
  validateToolExecutionCommand,
  validateToolExecutionPolicyMatchesIntent,
  type ToolExecutionCommand,
  type ToolExecutionPolicy,
  type ToolExecutionResolution,
  type ToolRuntimePort,
} from "@crewon/tool-broker";
import type { NetworkDnsResolver } from "../network-egress.ts";
import type { PinnedHttpPort } from "../pinned-node-http.ts";
import { ProductionComfyHttp, comfyServiceUrl } from "./comfyui-http.ts";
import { ComfyToolRuntime, comfyOperationId } from "./comfyui-tool-runtime.ts";
import {
  COMFY_SUBMIT_TOOL,
  comfyToolDefinitions,
  comfyToolExecutionPolicy,
} from "./comfyui-tool-catalog.ts";
import { comfyManifest } from "./comfyui-manifest.ts";

const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
type BindingContext = Readonly<{
  binding: ExtensionRunBinding;
  source: ExtensionRunBinding | null;
}>;

/** One immutable AgentVersion configuration; every execution resolves its own durable Run binding. */
export class BoundComfyToolRuntime implements ToolRuntimePort {
  readonly #configuration: ExtensionConfiguration;
  readonly #target: ExtensionExecutionTarget;
  readonly #bindingId: string;
  readonly #baseUrl: string;
  readonly #extensions: ExtensionStore;
  readonly #runs: Pick<RunStore, "loadRun">;
  readonly #operations: ExternalOperationStore;
  readonly #access: ExtensionExecutionAccessPort;
  readonly #approval: ToolExecutionPolicy["approvalRequirement"];
  readonly #dns: NetworkDnsResolver | undefined;
  readonly #transport: PinnedHttpPort | undefined;
  readonly #now: () => Date;
  readonly #active = new Map<AbortController, Promise<unknown>>();
  #closed = false;
  #closeTask: Promise<void> | null = null;

  constructor(input: {
    configuration: ExtensionConfiguration;
    target: ExtensionExecutionTarget;
    /** Registration must come from the host's verified bundled implementation, never a request. */
    registration: ExtensionRegistration;
    extensions: ExtensionStore;
    runs: Pick<RunStore, "loadRun">;
    operations: ExternalOperationStore;
    access: ExtensionExecutionAccessPort;
    approvalRequirement: ToolExecutionPolicy["approvalRequirement"];
    dns?: NetworkDnsResolver;
    transport?: PinnedHttpPort;
    now?: () => Date;
  }) {
    this.#configuration = parseExtensionConfiguration(
      input.configuration,
      digester,
    );
    this.#target = parseExtensionExecutionTarget(input.target);
    const manifest = comfyManifest();
    if (
      this.#configuration.pluginVersion !== manifest.version ||
      input.registration.manifestDigest !==
        digester.sha256(extensionCanonicalJson(manifest)) ||
      extensionCanonicalJson(input.registration.manifest) !==
        extensionCanonicalJson(manifest) ||
      this.#configuration.manifestDigest !==
        input.registration.manifestDigest ||
      this.#configuration.implementationDigest !==
        input.registration.implementationDigest
    )
      throw new Error("extension_implementation_mismatch");
    if (
      this.#configuration.pluginId !== "crewon.comfyui-krea2" ||
      this.#configuration.credentialBindings.length !== 0 ||
      Object.keys(this.#configuration.parameters).join() !== "baseUrl" ||
      typeof this.#configuration.parameters.baseUrl !== "string"
    )
      throw new Error("comfy_configuration_invalid");
    this.#baseUrl = comfyServiceUrl(this.#configuration.parameters.baseUrl);
    this.#bindingId = comfyRuntimeBindingId(this.#configuration, this.#target);
    this.#extensions = input.extensions;
    this.#runs = input.runs;
    this.#operations = input.operations;
    this.#access = input.access;
    this.#approval = input.approvalRequirement;
    this.#dns = input.dns;
    this.#transport = input.transport;
    this.#now = input.now ?? (() => new Date());
  }

  definitions() {
    return comfyToolDefinitions();
  }
  executionPolicy(kind: string, name: string) {
    return comfyToolExecutionPolicy(
      { bindingId: this.#bindingId, approvalRequirement: this.#approval },
      kind,
      name,
    );
  }
  execute(command: ToolExecutionCommand, signal: AbortSignal) {
    return this.#dispatch("execute", command, signal);
  }
  reconcile(command: ToolExecutionCommand, signal: AbortSignal) {
    return this.#dispatch("reconcile", command, signal);
  }
  cancel(command: ToolExecutionCommand, signal: AbortSignal) {
    return this.#dispatch("cancel", command, signal);
  }
  canRetire() {
    return !this.#closed && this.#active.size === 0;
  }
  close(): Promise<void> {
    if (this.#closeTask !== null) return this.#closeTask;
    this.#closed = true;
    for (const controller of this.#active.keys())
      controller.abort(new Error("extension_runtime_closed"));
    this.#closeTask = Promise.allSettled([...this.#active.values()]).then(
      () => {},
    );
    return this.#closeTask;
  }

  #dispatch(
    method: "execute" | "reconcile" | "cancel",
    commandInput: ToolExecutionCommand,
    signal: AbortSignal,
  ): Promise<ToolExecutionResolution> {
    if (this.#closed)
      return Promise.reject(new Error("extension_runtime_closed"));
    // ToolRuntime is shared by Runs; neither caller mutation nor a last-used binding may change identity.
    const command = structuredClone(commandInput);
    const controller = new AbortController();
    const bounded = AbortSignal.any([
      signal,
      controller.signal,
      AbortSignal.timeout(30_000),
    ]);
    const task = this.#invoke(method, command, bounded);
    this.#active.set(controller, task);
    void task.finally(() => this.#active.delete(controller)).catch(() => {});
    return task;
  }

  async #invoke(
    method: "execute" | "reconcile" | "cancel",
    command: ToolExecutionCommand,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    validateToolExecutionCommand(command);
    const policy = this.executionPolicy(command.kind, command.name);
    if (policy === null) throw new Error("comfy_tool_not_bound");
    validateToolExecutionPolicyMatchesIntent(policy, command.actionIntent);
    if (
      command.actionIntent.policySnapshotId !== this.#target.policySnapshotId ||
      command.actionIntent.workspaceBindingId !==
        this.#target.workspaceBindingId
    )
      throw new Error("extension_execution_target_mismatch");
    const context = await this.#load(command.runId);
    if (context.binding.source !== null && command.name === COMFY_SUBMIT_TOOL)
      throw new Error("comfy_query_submission_forbidden");
    const existingSubmission =
      command.name === COMFY_SUBMIT_TOOL
        ? await this.#operations.loadExternalOperation({
            tenantId: context.binding.tenantId,
            runId: context.binding.runId,
            bindingDigest: context.binding.bindingDigest,
            operationId: comfyOperationId(
              context.binding,
              command.idempotencyKey,
            ),
          })
        : null;
    // Resolve existing submissions passively even after ordinary disable. The HTTP gate alone grants POST.
    const newSubmission =
      command.name === COMFY_SUBMIT_TOOL &&
      method === "execute" &&
      existingSubmission === null;
    await this.#authorize(
      context,
      newSubmission ? "submit" : "observe",
      signal,
      { requireEnabled: newSubmission },
    );
    const runtime = new ComfyToolRuntime({
      scope: {
        tenantId: context.binding.tenantId,
        runId: context.binding.runId,
        bindingDigest: context.binding.bindingDigest,
      },
      ...(context.binding.source === null
        ? {}
        : {
            querySource: {
              tenantId: context.binding.tenantId,
              ...context.binding.source,
            },
          }),
      bindingId: this.#bindingId,
      baseUrl: this.#baseUrl,
      store: this.#operations,
      approvalRequirement: this.#approval,
      now: this.#now,
      http: new ProductionComfyHttp({
        baseUrl: this.#baseUrl,
        tenantId: context.binding.tenantId,
        bindingId: this.#bindingId,
        dns: this.#dns,
        transport: this.#transport,
        beforeDispatch: async (request) => {
          const fresh = await this.#load(command.runId);
          if (fresh.binding.bindingDigest !== context.binding.bindingDigest)
            throw new Error("extension_run_binding_changed");
          await this.#authorize(
            fresh,
            request.method === "POST" ? "submit" : "observe",
            request.signal,
            { requireEnabled: request.method === "POST" },
          );
          if (
            request.method === "POST" &&
            Date.parse(command.executionLease.expiresAt) <=
              this.#now().getTime()
          )
            throw new Error("comfy_execution_lease_expired");
        },
      }),
    });
    signal.throwIfAborted();
    return runtime[method](command, signal);
  }

  async #load(runId: string): Promise<BindingContext> {
    const binding = await this.#loadBinding(runId);
    const persisted = await this.#extensions.loadExtensionConfiguration({
      tenantId: binding.tenantId,
      spaceId: binding.spaceId,
      pluginId: binding.pluginId,
      revision: binding.configurationRevision,
    });
    if (
      persisted === null ||
      parseExtensionConfiguration(persisted, digester).contentDigest !==
        this.#configuration.contentDigest
    )
      throw new Error("extension_configuration_mismatch");
    if (binding.source === null) return { binding, source: null };
    const source = await this.#loadBinding(binding.source.runId);
    if (
      source.source !== null ||
      source.bindingDigest !== binding.source.bindingDigest
    )
      throw new Error("extension_query_source_invalid");
    const operation = await this.#operations.loadExternalOperation({
      tenantId: binding.tenantId,
      ...binding.source,
    });
    if (operation === null) throw new Error("extension_query_source_invalid");
    return { binding, source };
  }

  async #loadBinding(runId: string): Promise<ExtensionRunBinding> {
    const stored = await this.#extensions.loadExtensionRunBinding({
      tenantId: this.#configuration.tenantId,
      spaceId: this.#configuration.spaceId,
      runId,
    });
    if (stored === null) throw new Error("extension_run_binding_not_found");
    const binding = parseExtensionRunBinding(stored, digester);
    if (
      binding.runId !== runId ||
      binding.tenantId !== this.#configuration.tenantId ||
      binding.spaceId !== this.#configuration.spaceId ||
      binding.pluginId !== this.#configuration.pluginId ||
      binding.configurationRevision !== this.#configuration.revision ||
      binding.configurationDigest !== this.#configuration.contentDigest ||
      extensionCanonicalJson(binding.target) !==
        extensionCanonicalJson(this.#target)
    )
      throw new Error("extension_run_binding_mismatch");
    const run = await this.#runs.loadRun({ tenantId: binding.tenantId, runId });
    if (
      run === null ||
      run.tenantId !== binding.tenantId ||
      run.spaceId !== binding.spaceId ||
      run.threadId !== binding.threadId ||
      run.createdByActorId !== binding.actorId ||
      run.agentVersionId !== this.#target.agentVersionId ||
      run.authorityId !== this.#target.authorityId ||
      run.runtimeGeneration !== this.#target.runtimeGeneration ||
      run.policySnapshotId !== this.#target.policySnapshotId ||
      run.workspaceBindingId !== this.#target.workspaceBindingId
    )
      throw new Error("extension_run_authority_mismatch");
    return binding;
  }

  async #authorize(
    context: BindingContext,
    action: "submit" | "observe",
    signal: AbortSignal,
    options: { requireEnabled: boolean },
  ) {
    signal.throwIfAborted();
    const permission = await this.#access.authorize({
      ...context,
      action,
      signal,
    });
    signal.throwIfAborted();
    if (permission.outcome !== "allow")
      throw new Error("extension_execution_access_denied");
    const activation = await this.#extensions.loadExtensionActivation(
      context.binding,
    );
    signal.throwIfAborted();
    if (activation === null || activation.state === "revoked")
      throw new Error("extension_access_revoked");
    if (
      options.requireEnabled &&
      (activation.state !== "enabled" || context.source !== null)
    )
      throw new Error("extension_generation_disabled");
  }
}

export function comfyRuntimeBindingId(
  configuration: ExtensionConfiguration,
  target: ExtensionExecutionTarget,
): string {
  return `extension:${digester.sha256(extensionCanonicalJson({ configurationDigest: configuration.contentDigest, target })).slice(7)}`;
}
