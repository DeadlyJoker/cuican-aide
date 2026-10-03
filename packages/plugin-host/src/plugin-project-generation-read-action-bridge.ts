import {
  capturePluginUiInvocationCommitAuthority,
  type PluginUiActionContext,
  type PluginUiActionPort,
  type PluginUiInvocationCommitAuthority,
} from "@crewon/application";
import {
  CREWON_PROJECT_GENERATION_READS_API_VERSION,
  CREWON_PROJECT_GENERATION_READS_SERVICE,
  PROJECT_GENERATION_READ_UI_ACTIONS,
  parsePluginUiJsonValue,
  parseProjectGenerationReadUiActionResponse,
  type PluginUiJsonValue,
  type ProjectGenerationReadUiInput,
  type ProjectGenerationReadUiResponse,
} from "@crewon/contracts/plugins";
import { MAX_CREATIVE_PROJECT_RESPONSE_BYTES } from "@crewon/contracts";
import {
  parsePluginProfileScope,
  type PluginProfileScope,
} from "@crewon/domain";
import type { PluginActivationCandidate } from "./plugin-node-host.ts";
import {
  capturePluginUiHostServiceAvailability,
  type PluginUiHostServiceAvailabilityPort,
} from "./plugin-ui-host-service-availability.ts";
import { preserveProjectGenerationHostAvailability } from "./plugin-project-generation-host-availability.ts";
import { bridgeFields } from "./plugin-task-action-bridge-support.ts";
import {
  captureProjectGenerationReadContext,
  captureProjectGenerationReadPublications,
  readBridgeFailure,
  readBridgeMethod,
  type PluginProjectGenerationReadPublication,
} from "./plugin-project-generation-read-action-bridge-support.ts";

export type { PluginProjectGenerationReadPublication } from "./plugin-project-generation-read-action-bridge-support.ts";
export type PluginProjectGenerationReadDispatchPort = Readonly<{
  getConceptGeneration(
    input: Readonly<{
      context: PluginUiActionContext;
      request: ProjectGenerationReadUiInput;
      authority: PluginUiInvocationCommitAuthority;
    }>,
  ): Promise<ProjectGenerationReadUiResponse>;
  /** Actual assembly only. The application checks current project and original Run permissions. */
  isAvailable(
    input: Readonly<{
      scope: PluginProfileScope;
      candidate: PluginActivationCandidate;
      publication: PluginProjectGenerationReadPublication;
    }>,
  ): boolean;
}>;
export type PluginProjectGenerationReadActionBridgeDependencies = Readonly<{
  publications: readonly PluginProjectGenerationReadPublication[];
  reads: PluginProjectGenerationReadDispatchPort;
}>;
const owners = new WeakSet<object>();
export function isPluginProjectGenerationReadActionBridge(
  input: unknown,
): input is PluginProjectGenerationReadActionBridge {
  return input !== null && typeof input === "object" && owners.has(input);
}

/** A plain JSON read of saved history; no Node dispatch, task acknowledgement or credit authority. */
export class PluginProjectGenerationReadActionBridge {
  readonly #publications: readonly PluginProjectGenerationReadPublication[];
  readonly #reads: PluginProjectGenerationReadDispatchPort;
  readonly #pending = new Map<
    PluginUiActionContext,
    Promise<PluginUiJsonValue>
  >();
  #closed = false;
  #closing: Promise<void> | undefined;

  constructor(input: PluginProjectGenerationReadActionBridgeDependencies) {
    const fields = bridgeFields(input, ["publications", "reads"]);
    this.#publications = captureProjectGenerationReadPublications(
      fields.publications,
    );
    const reads = fields.reads as PluginProjectGenerationReadDispatchPort;
    this.#reads = Object.freeze({
      getConceptGeneration: readBridgeMethod(reads, "getConceptGeneration"),
      isAvailable: readBridgeMethod(reads, "isAvailable"),
    });
    owners.add(this);
  }

  supportsAction(action: string): boolean {
    return action === PROJECT_GENERATION_READ_UI_ACTIONS[0];
  }
  actions(fallback: PluginUiActionPort): PluginUiActionPort {
    const invoke = readBridgeMethod(fallback, "invoke");
    return Object.freeze({
      invoke: (context: PluginUiActionContext) => {
        const action = Object.getOwnPropertyDescriptor(context, "action");
        if (
          !action?.enumerable ||
          !Object.hasOwn(action, "value") ||
          typeof action.value !== "string"
        )
          readBridgeFailure("plugin_project_generation_read_action_invalid");
        if (this.supportsAction(action.value)) return this.#invoke(context);
        if (
          action.value === CREWON_PROJECT_GENERATION_READS_SERVICE ||
          action.value.startsWith(`${CREWON_PROJECT_GENERATION_READS_SERVICE}.`)
        )
          readBridgeFailure("plugin_project_generation_read_action_invalid");
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
          input.requirement.service !== CREWON_PROJECT_GENERATION_READS_SERVICE
        )
          return other?.isAvailable(input) === true;
        if (
          this.#closed ||
          input.requirement.apiVersion !==
            CREWON_PROJECT_GENERATION_READS_API_VERSION
        )
          return false;
        const publication = this.#publications.find(
          (item) =>
            item.pluginId === input.candidate.descriptor.pluginId &&
            item.packageDigest === input.candidate.packageDigest &&
            input.candidate.descriptor.contributions.some(
              (contribution) =>
                contribution.id === item.contributionId &&
                contribution.kind === "module" &&
                contribution.slot === "main.content",
            ),
        );
        if (publication === undefined) return false;
        try {
          const answer = this.#reads.isAvailable(
            Object.freeze({
              scope: parsePluginProfileScope(input.scope),
              candidate: input.candidate,
              publication,
            }),
          );
          if (answer === true) return true;
          try {
            Promise.prototype.then.call(
              answer,
              () => undefined,
              () => undefined,
            );
          } catch {
            /* Not a real Promise; no then getter is consulted. */
          }
        } catch {
          /* A missing assembly cannot grant a read. */
        }
        return false;
      },
    });
    return other === undefined
      ? port
      : preserveProjectGenerationHostAvailability(other, port);
  }

  close(): Promise<void> {
    this.#closed = true;
    return (this.#closing ??= Promise.allSettled([
      ...this.#pending.values(),
    ]).then(() => undefined));
  }

  #invoke(context: PluginUiActionContext): Promise<PluginUiJsonValue> {
    if (this.#closed) readBridgeFailure();
    const existing = this.#pending.get(context);
    if (existing !== undefined) return existing;
    if (this.#pending.size >= 128) readBridgeFailure("plugin_invocation_limit");
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
    const captured = captureProjectGenerationReadContext(original);
    if (
      !this.#publications.some(
        (item) =>
          item.pluginId === captured.context.package.pluginId &&
          item.packageDigest === captured.context.package.packageDigest &&
          item.contributionId === captured.context.lease.contributionId,
      )
    )
      readBridgeFailure("plugin_project_generation_read_publication_missing");
    const assertActive = () => {
      if (this.#closed) readBridgeFailure();
      current.assertActive();
      if (
        captureProjectGenerationReadContext(original).fingerprint !==
        captured.fingerprint
      )
        readBridgeFailure("plugin_project_generation_read_context_changed");
    };
    const authority = Object.freeze({
      assertActive,
      assertCurrent: async () => {
        assertActive();
        await current.assertCurrent();
        assertActive();
      },
    });
    await authority.assertCurrent();
    const output = await this.#reads.getConceptGeneration(
      Object.freeze({
        context: captured.context,
        request: captured.request.input,
        authority,
      }),
    );
    const detached = parseProjectGenerationReadUiActionResponse(
      captured.request,
      output,
    );
    const result = parsePluginUiJsonValue(detached, {
      maxBytes: MAX_CREATIVE_PROJECT_RESPONSE_BYTES,
    });
    await authority.assertCurrent();
    return result;
  }
}
