import {
  CREWON_PROJECT_HISTORICAL_QUERIES_API_VERSION,
  CREWON_PROJECT_HISTORICAL_QUERIES_SERVICE,
  PROJECT_HISTORICAL_QUERY_UI_ACTIONS,
  parsePluginUiJsonValue,
  parseProjectHistoricalQueryUiActionRequest,
  type ProjectHistoricalQueryUiInput,
} from "@crewon/contracts/plugins";
import {
  assertProjectHistoricalQueryExecutionPublication,
  captureProjectHistoricalQueryPublications,
  parseProjectHistoricalQueryPublication,
  parsePluginProfileScope,
  parsePluginTaskAdmissionPin,
  type PluginProfileScope,
  type PluginTaskAdmissionPin,
  type ProjectHistoricalQueryPublication,
} from "@crewon/domain";
import {
  capturePluginHistoricalQueryInvocationCommitAuthority,
  fencePluginHistoricalQueryInvocationAuthority,
  type CommitExtensionTurnResult,
  type CreateExtensionTaskCommand,
  type PluginUiActionContext,
  type PluginUiActionPort,
  type PluginUiCommittedTaskAuthority,
  type PluginUiCommittedTaskOutcome,
  type PluginHistoricalQueryInvocationAuthority,
} from "@crewon/application";
import type { PluginActivationCandidate } from "./plugin-node-host.ts";
import {
  capturePluginUiHostServiceAvailability,
  type PluginUiHostServiceAvailabilityPort,
} from "./plugin-ui-host-service-availability.ts";
import { preserveProjectGenerationHostAvailability } from "./plugin-project-generation-host-availability.ts";
import { preserveProjectGenerationContextHostAvailability } from "./plugin-project-generation-context-host-availability.ts";
import { registerProjectHistoricalQueryHostAvailability } from "./plugin-project-historical-query-host-availability.ts";
import {
  projectGenerationBridgeMethod,
  projectGenerationSynchronousAvailable,
} from "./plugin-project-generation-action-bridge-support.ts";
import { assertPluginProjectHistoricalQuerySource } from "./plugin-project-historical-query-action-bridge-support.ts";
import {
  bridgeFailure,
  bridgeFields,
  bridgePin,
} from "./plugin-task-action-bridge-support.ts";

/** Actual Control owner resolves the original saved generation and independently installed query package. */
export type PluginProjectHistoricalQueryDispatchPort = Readonly<{
  query(
    input: Readonly<{
      context: PluginUiActionContext;
      sourcePin: PluginTaskAdmissionPin;
      publications: readonly ProjectHistoricalQueryPublication[];
      request: ProjectHistoricalQueryUiInput;
      authority: PluginHistoricalQueryInvocationAuthority;
    }>,
  ): Promise<
    Readonly<{
      publication: ProjectHistoricalQueryPublication;
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
      publication: ProjectHistoricalQueryPublication;
    }>,
  ): boolean;
}>;
export type PluginProjectHistoricalQueryActionBridgeDependencies = Readonly<{
  publications: readonly ProjectHistoricalQueryPublication[];
  generation: PluginProjectHistoricalQueryDispatchPort;
  committedTasks: Pick<
    PluginUiCommittedTaskAuthority,
    "issueProjectHistoricalQuery"
  >;
}>;

/** Reserved Host dispatcher; the source invocation stays owned by its original business package. */
export class PluginProjectHistoricalQueryActionBridge {
  readonly #publications: readonly ProjectHistoricalQueryPublication[];
  readonly #generation: PluginProjectHistoricalQueryDispatchPort;
  readonly #issue: PluginUiCommittedTaskAuthority["issueProjectHistoricalQuery"];
  readonly #pending = new Map<
    PluginUiActionContext,
    Promise<PluginUiCommittedTaskOutcome>
  >();
  #closed = false;

  constructor(input: PluginProjectHistoricalQueryActionBridgeDependencies) {
    const fields = bridgeFields(input, [
      "publications",
      "generation",
      "committedTasks",
    ]);
    this.#publications = captureProjectHistoricalQueryPublications(
      fields.publications,
    );
    const generation =
      fields.generation as PluginProjectHistoricalQueryDispatchPort;
    this.#generation = Object.freeze({
      query: projectGenerationBridgeMethod(generation, "query"),
      isAvailable: projectGenerationBridgeMethod(generation, "isAvailable"),
    });
    this.#issue = projectGenerationBridgeMethod(
      fields.committedTasks as PluginProjectHistoricalQueryActionBridgeDependencies["committedTasks"],
      "issueProjectHistoricalQuery",
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
        if (action.value === PROJECT_HISTORICAL_QUERY_UI_ACTIONS[0])
          return this.#invoke(context);
        if (
          action.value === CREWON_PROJECT_HISTORICAL_QUERIES_SERVICE ||
          action.value.startsWith(
            `${CREWON_PROJECT_HISTORICAL_QUERIES_SERVICE}.`,
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
          CREWON_PROJECT_HISTORICAL_QUERIES_SERVICE
        )
          return metadata?.isAvailable(input) === true;
        if (
          this.#closed ||
          input.requirement.apiVersion !==
            CREWON_PROJECT_HISTORICAL_QUERIES_API_VERSION
        )
          return false;
        const publications = this.#publications.filter(
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
        if (publications.length === 0) return false;
        try {
          return publications.some((publication) =>
            projectGenerationSynchronousAvailable(
              this.#generation.isAvailable(
                Object.freeze({
                  scope: parsePluginProfileScope(input.scope),
                  candidate: input.candidate,
                  publication,
                }),
              ),
            ),
          );
        } catch {
          return false;
        }
      },
    });
    return registerProjectHistoricalQueryHostAvailability(
      metadata === undefined
        ? port
        : preserveProjectGenerationContextHostAvailability(
            metadata,
            preserveProjectGenerationHostAvailability(metadata, port),
          ),
    );
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#pending.values()]);
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
    const current =
      capturePluginHistoricalQueryInvocationCommitAuthority(context);
    const request = parseProjectHistoricalQueryUiActionRequest({
      action: context.action,
      input: context.input,
    });
    const sourcePin = bridgePin(context);
    assertPluginProjectHistoricalQuerySource(context, sourcePin);
    const publications = this.#publications.filter((item) =>
      (["pluginId", "packageDigest", "contributionId"] as const).every(
        (k) => item.source[k] === sourcePin[k],
      ),
    );
    if (publications.length === 0)
      bridgeFailure("plugin_project_historical_query_publication_missing");
    const assertActive = () => {
      if (this.#closed)
        bridgeFailure("plugin_project_generation_query_unavailable");
      current.assertActive();
    };
    const authority = fencePluginHistoricalQueryInvocationAuthority(
      current,
      assertActive,
    );
    await authority.assertCurrent();
    const dispatched = await this.#generation.query(
      Object.freeze({
        context,
        sourcePin,
        publications,
        request: request.input,
        authority,
      }),
    );
    const fields = bridgeFields(dispatched, [
      "publication",
      "command",
      "executionPin",
      "result",
    ]);
    const publication = parseProjectHistoricalQueryPublication(
      fields.publication,
    );
    if (
      !publications.some(
        (p) => JSON.stringify(p) === JSON.stringify(publication),
      )
    )
      bridgeFailure("plugin_project_historical_query_target_unapproved");
    const executionPin = parsePluginTaskAdmissionPin(fields.executionPin);
    assertProjectHistoricalQueryExecutionPublication({
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
