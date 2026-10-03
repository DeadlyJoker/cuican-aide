import {
  capturePluginUiInvocationCommitAuthority,
  type PluginUiActionContext,
  type PluginUiActionPort,
  type PluginUiInvocationCommitAuthority,
} from "@crewon/application";
import {
  CREWON_PROJECT_GENERATION_CONTEXTS_API_VERSION,
  CREWON_PROJECT_GENERATION_CONTEXTS_SERVICE,
  PROJECT_GENERATION_CONTEXT_UI_ACTIONS,
  parsePluginUiJsonValue,
  parseProjectGenerationContextUiActionResponse,
  type PluginUiJsonValue,
  type ProjectGenerationContextUiResponse,
  type ProjectGenerationUiReference,
} from "@crewon/contracts/plugins";
import {
  captureProjectGenerationPublications,
  parsePluginProfileScope,
  type PluginProfileScope,
  type PluginTaskAdmissionPin,
  type ProjectGenerationPublication,
} from "@crewon/domain";
import type { PluginActivationCandidate } from "./plugin-node-host.ts";
import {
  capturePluginUiHostServiceAvailability,
  type PluginUiHostServiceAvailabilityPort,
} from "./plugin-ui-host-service-availability.ts";
import { preserveProjectGenerationHostAvailability } from "./plugin-project-generation-host-availability.ts";
import { registerProjectGenerationContextHostAvailability } from "./plugin-project-generation-context-host-availability.ts";
import { projectGenerationSynchronousAvailable } from "./plugin-project-generation-action-bridge-support.ts";
import { bridgeFields } from "./plugin-task-action-bridge-support.ts";
import {
  captureProjectGenerationContext,
  contextBridgeFailure,
  contextBridgeMethod,
} from "./plugin-project-generation-context-action-bridge-support.ts";

export type PluginProjectGenerationContextDispatchPort = Readonly<{
  getReadiness(
    input: Readonly<{
      context: PluginUiActionContext;
      sourcePin: PluginTaskAdmissionPin;
      publication: ProjectGenerationPublication;
      reference: ProjectGenerationUiReference;
      authority: PluginUiInvocationCommitAuthority;
    }>,
  ): Promise<ProjectGenerationContextUiResponse>;
  /** Synchronous assembly only; this cannot authorize a project, task or charge. */
  isAvailable(
    input: Readonly<{
      scope: PluginProfileScope;
      candidate: PluginActivationCandidate;
      publication: ProjectGenerationPublication;
    }>,
  ): boolean;
}>;
export type PluginProjectGenerationContextActionBridgeDependencies = Readonly<{
  publications: readonly ProjectGenerationPublication[];
  contexts: PluginProjectGenerationContextDispatchPort;
}>;
const owners = new WeakSet<object>();
export function isPluginProjectGenerationContextActionBridge(
  input: unknown,
): input is PluginProjectGenerationContextActionBridge {
  return input !== null && typeof input === "object" && owners.has(input);
}

/** A bounded current capability read with no task receipt, Node dispatch or credit authority. */
export class PluginProjectGenerationContextActionBridge {
  readonly #publications: readonly ProjectGenerationPublication[];
  readonly #contexts: PluginProjectGenerationContextDispatchPort;
  readonly #pending = new Map<
    PluginUiActionContext,
    Promise<PluginUiJsonValue>
  >();
  #closed = false;
  #closing: Promise<void> | undefined;

  constructor(input: PluginProjectGenerationContextActionBridgeDependencies) {
    const fields = bridgeFields(input, ["publications", "contexts"]);
    this.#publications = captureProjectGenerationPublications(
      fields.publications,
    );
    const contexts =
      fields.contexts as PluginProjectGenerationContextDispatchPort;
    this.#contexts = Object.freeze({
      getReadiness: contextBridgeMethod(contexts, "getReadiness"),
      isAvailable: contextBridgeMethod(contexts, "isAvailable"),
    });
    owners.add(this);
  }

  supportsAction(action: string): boolean {
    return action === PROJECT_GENERATION_CONTEXT_UI_ACTIONS[0];
  }

  actions(fallback: PluginUiActionPort): PluginUiActionPort {
    const invoke = contextBridgeMethod(fallback, "invoke");
    return Object.freeze({
      invoke: (context: PluginUiActionContext) => {
        const action = Object.getOwnPropertyDescriptor(context, "action");
        if (
          !action?.enumerable ||
          !Object.hasOwn(action, "value") ||
          typeof action.value !== "string"
        )
          contextBridgeFailure(
            "plugin_project_generation_context_action_invalid",
          );
        if (this.supportsAction(action.value)) return this.#invoke(context);
        if (
          action.value === CREWON_PROJECT_GENERATION_CONTEXTS_SERVICE ||
          action.value.startsWith(
            `${CREWON_PROJECT_GENERATION_CONTEXTS_SERVICE}.`,
          )
        )
          contextBridgeFailure(
            "plugin_project_generation_context_action_invalid",
          );
        return invoke(context);
      },
    });
  }

  hostUiServices(
    base?: PluginUiHostServiceAvailabilityPort,
  ): PluginUiHostServiceAvailabilityPort {
    const other = capturePluginUiHostServiceAvailability(base);
    const port: PluginUiHostServiceAvailabilityPort = Object.freeze({
      isAvailable: (input) => {
        if (
          input.requirement.service !==
          CREWON_PROJECT_GENERATION_CONTEXTS_SERVICE
        )
          return other?.isAvailable(input) === true;
        if (
          this.#closed ||
          input.requirement.apiVersion !==
            CREWON_PROJECT_GENERATION_CONTEXTS_API_VERSION
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
            this.#contexts.isAvailable(
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
    return registerProjectGenerationContextHostAvailability(
      other === undefined
        ? port
        : preserveProjectGenerationHostAvailability(other, port),
    );
  }

  close(): Promise<void> {
    this.#closed = true;
    return (this.#closing ??= Promise.allSettled([
      ...this.#pending.values(),
    ]).then(() => undefined));
  }

  #invoke(context: PluginUiActionContext): Promise<PluginUiJsonValue> {
    if (this.#closed) contextBridgeFailure();
    const existing = this.#pending.get(context);
    if (existing !== undefined) return existing;
    if (this.#pending.size >= 128)
      contextBridgeFailure("plugin_invocation_limit");
    const pending = this.#read(context);
    this.#pending.set(context, pending);
    void pending.then(
      () => this.#pending.delete(context),
      () => this.#pending.delete(context),
    );
    return pending;
  }

  async #read(original: PluginUiActionContext): Promise<PluginUiJsonValue> {
    const current = capturePluginUiInvocationCommitAuthority(original);
    const captured = captureProjectGenerationContext(original);
    const publication = this.#publications.find(
      (item) =>
        item.source.pluginId === captured.sourcePin.pluginId &&
        item.source.packageDigest === captured.sourcePin.packageDigest &&
        item.source.contributionId === captured.sourcePin.contributionId,
    );
    if (publication === undefined)
      contextBridgeFailure(
        "plugin_project_generation_context_publication_missing",
      );
    const assertActive = () => {
      if (this.#closed) contextBridgeFailure();
      current.assertActive();
      if (
        captureProjectGenerationContext(original).fingerprint !==
        captured.fingerprint
      )
        contextBridgeFailure("plugin_project_generation_context_changed");
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
    const output = await this.#contexts.getReadiness(
      Object.freeze({
        // The actual owner independently captures this invocation's private membership.
        context: original,
        sourcePin: captured.sourcePin,
        publication,
        reference: captured.request.input.reference,
        authority,
      }),
    );
    const detached = parseProjectGenerationContextUiActionResponse(
      captured.request,
      output,
    );
    const result = parsePluginUiJsonValue(detached, { maxBytes: 24 * 1024 });
    await authority.assertCurrent();
    return result;
  }
}
