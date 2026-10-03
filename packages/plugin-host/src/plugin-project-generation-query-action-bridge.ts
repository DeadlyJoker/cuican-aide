import {
  CREWON_PROJECT_GENERATION_QUERIES_API_VERSION,
  CREWON_PROJECT_GENERATION_QUERIES_SERVICE,
  PROJECT_GENERATION_QUERY_UI_ACTIONS,
  parsePluginUiJsonValue,
  parseProjectGenerationQueryUiActionRequest,
  type ProjectGenerationQueryUiInput,
} from "@crewon/contracts/plugins";
import {
  assertProjectQueryExecutionPublication,
  captureProjectQueryPublications,
  parsePluginProfileScope,
  parsePluginTaskAdmissionPin,
  type PluginProfileScope,
  type PluginTaskAdmissionPin,
  type ProjectQueryPublication,
} from "@crewon/domain";
import {
  capturePluginUiInvocationCommitAuthority,
  type CommitExtensionTurnResult,
  type CreateExtensionTaskCommand,
  type PluginUiActionContext,
  type PluginUiActionPort,
  type PluginUiCommittedTaskAuthority,
  type PluginUiCommittedTaskOutcome,
  type PluginUiInvocationCommitAuthority,
} from "@crewon/application";
import type { PluginActivationCandidate } from "./plugin-node-host.ts";
import {
  capturePluginUiHostServiceAvailability,
  type PluginUiHostServiceAvailabilityPort,
} from "./plugin-ui-host-service-availability.ts";
import { preserveProjectGenerationHostAvailability } from "./plugin-project-generation-host-availability.ts";
import { preserveProjectGenerationContextHostAvailability } from "./plugin-project-generation-context-host-availability.ts";
import { registerProjectGenerationQueryHostAvailability } from "./plugin-project-generation-query-host-availability.ts";
import {
  projectGenerationBridgeMethod,
  projectGenerationSynchronousAvailable,
} from "./plugin-project-generation-action-bridge-support.ts";
import { assertPluginProjectGenerationQuerySource } from "./plugin-project-generation-query-action-bridge-support.ts";
import {
  bridgeFailure,
  bridgeFields,
  bridgePin,
} from "./plugin-task-action-bridge-support.ts";

/** Actual Control owner resolves the original saved generation and independently installed query package. */
export type PluginProjectGenerationQueryDispatchPort = Readonly<{
  query(
    input: Readonly<{
      context: PluginUiActionContext;
      sourcePin: PluginTaskAdmissionPin;
      publication: ProjectQueryPublication;
      request: ProjectGenerationQueryUiInput;
      authority: PluginUiInvocationCommitAuthority;
    }>,
  ): Promise<
    Readonly<{
      command: CreateExtensionTaskCommand;
      executionPin: PluginTaskAdmissionPin;
      result: CommitExtensionTurnResult;
    }>
  >;
  /** Synchronous assembly/selection readiness only; never grants actor, project or credit permission. */
  isAvailable(
    input: Readonly<{
      scope: PluginProfileScope;
      candidate: PluginActivationCandidate;
      publication: ProjectQueryPublication;
    }>,
  ): boolean;
}>;
export type PluginProjectGenerationQueryActionBridgeDependencies = Readonly<{
  publications: readonly ProjectQueryPublication[];
  generation: PluginProjectGenerationQueryDispatchPort;
  committedTasks: Pick<
    PluginUiCommittedTaskAuthority,
    "issueProjectGenerationQuery"
  >;
}>;

/** Reserved Host dispatcher; the source invocation stays owned by its original business package. */
export class PluginProjectGenerationQueryActionBridge {
  readonly #publications: readonly ProjectQueryPublication[];
  readonly #generation: PluginProjectGenerationQueryDispatchPort;
  readonly #issue: PluginUiCommittedTaskAuthority["issueProjectGenerationQuery"];
  readonly #pending = new Map<
    PluginUiActionContext,
    Promise<PluginUiCommittedTaskOutcome>
  >();
  #closed = false;

  constructor(input: PluginProjectGenerationQueryActionBridgeDependencies) {
    const fields = bridgeFields(input, [
      "publications",
      "generation",
      "committedTasks",
    ]);
    this.#publications = captureProjectQueryPublications(fields.publications);
    const generation =
      fields.generation as PluginProjectGenerationQueryDispatchPort;
    this.#generation = Object.freeze({
      query: projectGenerationBridgeMethod(generation, "query"),
      isAvailable: projectGenerationBridgeMethod(generation, "isAvailable"),
    });
    this.#issue = projectGenerationBridgeMethod(
      fields.committedTasks as PluginProjectGenerationQueryActionBridgeDependencies["committedTasks"],
      "issueProjectGenerationQuery",
    );
  }

  actions(fallback: PluginUiActionPort): PluginUiActionPort {
    const invoke = projectGenerationBridgeMethod(fallback, "invoke");
    return Object.freeze({
      invoke: (context: PluginUiActionContext) => {
        const action = Object.getOwnPropertyDescriptor(context, "action");
        if (
          !action?.enumerable ||
          !("value" in action) ||
          typeof action.value !== "string"
        )
          bridgeFailure("plugin_project_generation_query_action_invalid");
        if (action.value === PROJECT_GENERATION_QUERY_UI_ACTIONS[0])
          return this.#invoke(context);
        if (
          action.value === CREWON_PROJECT_GENERATION_QUERIES_SERVICE ||
          action.value.startsWith(
            `${CREWON_PROJECT_GENERATION_QUERIES_SERVICE}.`,
          )
        )
          bridgeFailure("plugin_project_generation_query_action_invalid");
        // Ordinary task and metadata paths retain their existing authority, data access and timing.
        return invoke(context);
      },
    });
  }

  /** Only this explicitly assembled bridge can publish the new UI-only requirement. */
  hostUiServices(
    base?: PluginUiHostServiceAvailabilityPort,
  ): PluginUiHostServiceAvailabilityPort {
    const metadata = capturePluginUiHostServiceAvailability(base);
    const port: PluginUiHostServiceAvailabilityPort = Object.freeze({
      isAvailable: (
        input: Parameters<
          PluginUiHostServiceAvailabilityPort["isAvailable"]
        >[0],
      ) => {
        if (
          input.requirement.service !==
          CREWON_PROJECT_GENERATION_QUERIES_SERVICE
        )
          return metadata?.isAvailable(input) === true;
        if (
          this.#closed ||
          input.requirement.apiVersion !==
            CREWON_PROJECT_GENERATION_QUERIES_API_VERSION
        )
          return false;
        const publication = this.#publications.find(
          (item) =>
            item.source.pluginId === input.candidate.descriptor.pluginId &&
            item.source.packageDigest === input.candidate.packageDigest &&
            input.candidate.descriptor.contributions.some(
              (contribution) =>
                contribution.id === item.source.contributionId &&
                contribution.kind === "module" &&
                contribution.slot === "main.content",
            ),
        );
        if (publication === undefined) return false;
        try {
          return projectGenerationSynchronousAvailable(
            this.#generation.isAvailable(
              Object.freeze({
                scope: parsePluginProfileScope(input.scope),
                candidate: input.candidate,
                publication,
              }),
            ),
          );
        } catch {
          return false;
        }
      },
    });
    return registerProjectGenerationQueryHostAvailability(
      metadata === undefined
        ? port
        : preserveProjectGenerationContextHostAvailability(
            metadata,
            preserveProjectGenerationHostAvailability(metadata, port),
          ),
    );
  }

  close(): void {
    this.#closed = true;
  }

  #invoke(
    context: PluginUiActionContext,
  ): Promise<PluginUiCommittedTaskOutcome> {
    if (this.#closed)
      bridgeFailure("plugin_project_generation_query_unavailable");
    const existing = this.#pending.get(context);
    if (existing !== undefined) return existing;
    if (this.#pending.size >= 128) bridgeFailure("plugin_invocation_limit");
    const pending = this.#query(context);
    this.#pending.set(context, pending);
    void pending.then(
      () => this.#pending.delete(context),
      () => this.#pending.delete(context),
    );
    return pending;
  }

  async #query(
    context: PluginUiActionContext,
  ): Promise<PluginUiCommittedTaskOutcome> {
    const current = capturePluginUiInvocationCommitAuthority(context);
    const request = parseProjectGenerationQueryUiActionRequest({
      action: context.action,
      input: context.input,
    });
    const sourcePin = bridgePin(context);
    assertPluginProjectGenerationQuerySource(context, sourcePin);
    const publication = this.#publications.find(
      (item) =>
        item.source.pluginId === sourcePin.pluginId &&
        item.source.packageDigest === sourcePin.packageDigest &&
        item.source.contributionId === sourcePin.contributionId,
    );
    if (publication === undefined)
      bridgeFailure("plugin_project_generation_query_publication_missing");
    const assertActive = () => {
      if (this.#closed)
        bridgeFailure("plugin_project_generation_query_unavailable");
      current.assertActive();
    };
    const authority: PluginUiInvocationCommitAuthority = Object.freeze({
      assertActive,
      assertCurrent: async () => {
        assertActive();
        await current.assertCurrent();
        assertActive();
      },
    });
    await authority.assertCurrent();
    const dispatched = await this.#generation.query(
      Object.freeze({
        context,
        sourcePin,
        publication,
        request: request.input,
        authority,
      }),
    );
    const fields = bridgeFields(dispatched, [
      "command",
      "executionPin",
      "result",
    ]);
    const executionPin = parsePluginTaskAdmissionPin(fields.executionPin);
    assertProjectQueryExecutionPublication({
      publication,
      sourcePin,
      executionPin,
    });
    // Capture the claim before verification yields to storage. The authority verifies the original query Run/sidecar itself.
    const command = parsePluginUiJsonValue(
      fields.command,
    ) as unknown as CreateExtensionTaskCommand;
    const result = parsePluginUiJsonValue(
      fields.result,
    ) as unknown as CommitExtensionTurnResult;
    // An acknowledged commit stays acknowledged after close/revocation; no new admission occurs here.
    return this.#issue({ context, command, executionPin, result });
  }
}
