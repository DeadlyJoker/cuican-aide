import {
  ApplicationError,
  ProjectConceptSelectionApplicationService,
  capturePluginUiInvocationCommitAuthority,
  type PluginUiActionContext,
  type PluginUiActionPort,
  type PluginUiCommittedMetadataOutcome,
  type PluginUiCommittedMetadataPort,
  type ProjectGenerationExecutionAuthority,
} from "@crewon/application";
import {
  CREWON_PROJECT_GENERATION_SELECTIONS_SERVICE,
  CREWON_PROJECT_GENERATION_SELECTIONS_API_VERSION,
  PROJECT_GENERATION_SELECTION_UI_ACTIONS,
  parsePluginUiJsonValue,
  parseProjectGenerationSelectionUiActionResponse,
  type PluginUiJsonValue,
} from "@crewon/contracts/plugins";
import { MAX_PROJECT_GENERATION_SELECTION_BYTES } from "@crewon/contracts";
import {
  appendProjectGenerationSelectionUiServiceAvailability,
  type PluginUiHostServiceAvailabilityPort,
} from "@crewon/plugin-host";
import {
  captureCreativeProjectPluginUiConfig,
  type CreativeProjectPluginUiConfig,
} from "./creative-project-plugin-ui-composition.ts";
import {
  projectConceptImageSelection,
  projectConceptSelection,
} from "./project-generation-selection-projection.ts";
import {
  selectionUiMethod,
  selectionUiSnapshot,
  selectionUiUnavailable,
} from "./project-generation-selection-plugin-ui-support.ts";

import { pluginSecurityRecord } from "./plugin-security-validation.ts";

type Authorization = Readonly<{
  authorize(context: PluginUiActionContext): Promise<void>;
}>;
type Verified = Readonly<{
  context: PluginUiActionContext;
  fingerprint: string;
  output: PluginUiJsonValue;
}>;
const actualOwners = new WeakSet<object>();
const outcomePrototype = Object.freeze(Object.create(null) as object);
const supportedActions = new Set<string>(
  PROJECT_GENERATION_SELECTION_UI_ACTIONS,
);

export function isProjectGenerationSelectionPluginUiOwner(
  value: unknown,
): value is ProjectGenerationSelectionPluginUiOwner {
  return value !== null && typeof value === "object" && actualOwners.has(value);
}

/** Only an actual selection Service return can issue this independent metadata outcome. */
export class ProjectGenerationSelectionPluginUiOwner {
  readonly actions: PluginUiActionPort;
  readonly committedMetadata: PluginUiCommittedMetadataPort;
  readonly #publications: CreativeProjectPluginUiConfig["publications"];
  readonly #get: ProjectConceptSelectionApplicationService["getConceptSelection"];
  readonly #select: ProjectConceptSelectionApplicationService["selectConceptImage"];
  readonly #authorize: Authorization["authorize"];
  readonly #outcomes = new WeakMap<object, Verified>();
  #closed = false;
  #pending = 0;
  #closing: Promise<void> | undefined;
  #finishClose: (() => void) | undefined;

  constructor(
    input: Readonly<{
      configuration: CreativeProjectPluginUiConfig;
      selections: ProjectConceptSelectionApplicationService;
      authorization: Authorization;
    }>,
  ) {
    const fields = pluginSecurityRecord(input, [
      "configuration",
      "selections",
      "authorization",
    ]);
    const selections = fields.selections;
    if (!(selections instanceof ProjectConceptSelectionApplicationService))
      throw new Error("project_generation_selection_service_required");
    this.#publications = captureCreativeProjectPluginUiConfig(
      fields.configuration,
    )!.publications;
    this.#get =
      ProjectConceptSelectionApplicationService.prototype.getConceptSelection.bind(
        selections,
      );
    this.#select =
      ProjectConceptSelectionApplicationService.prototype.selectConceptImage.bind(
        selections,
      );
    this.#authorize = selectionUiMethod(
      fields.authorization as Authorization,
      "authorize",
    );
    this.actions = Object.freeze({
      invoke: (context: PluginUiActionContext) => this.#invoke(context),
    });
    this.committedMetadata = Object.freeze({
      isOutcome: (input: unknown): input is PluginUiCommittedMetadataOutcome =>
        input !== null &&
        typeof input === "object" &&
        this.#outcomes.has(input),
      verify: (
        context: PluginUiActionContext,
        outcome: PluginUiCommittedMetadataOutcome,
      ) => this.#verify(context, outcome),
    });
    actualOwners.add(this);
    Object.freeze(this);
  }
  supportsAction(action: string): boolean {
    return supportedActions.has(action);
  }
  assertAvailable(): void {
    if (this.#closed) selectionUiUnavailable();
  }
  hostUiServices(
    fallback?: PluginUiHostServiceAvailabilityPort,
  ): PluginUiHostServiceAvailabilityPort {
    const selection: PluginUiHostServiceAvailabilityPort = Object.freeze({
      isAvailable: (input) => {
        if (
          input.requirement.service !==
          CREWON_PROJECT_GENERATION_SELECTIONS_SERVICE
        )
          return false;
        if (
          this.#closed ||
          input.requirement.apiVersion !==
            CREWON_PROJECT_GENERATION_SELECTIONS_API_VERSION
        )
          return false;
        return this.#publications.some(
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
      },
    });
    return appendProjectGenerationSelectionUiServiceAvailability({
      selection,
      ...(fallback === undefined ? {} : { fallback }),
    });
  }
  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    this.#closed = true;
    return (this.#closing =
      this.#pending === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            this.#finishClose = resolve;
          }));
  }
  async #invoke(invocation: PluginUiActionContext) {
    this.assertAvailable();
    const captured = capturePluginUiInvocationCommitAuthority(invocation);
    const snapshot = selectionUiSnapshot(invocation);
    const context = snapshot.context;
    const publication = this.#publications.find(
      (item) =>
        item.pluginId === context.lease.descriptor.pluginId &&
        item.packageDigest === context.package.packageDigest &&
        item.contributionId === context.lease.contributionId,
    );
    if (publication === undefined) selectionUiUnavailable();
    let active = true;
    const authority: ProjectGenerationExecutionAuthority = Object.freeze({
      assertActive: () => {
        this.assertAvailable();
        if (!active) selectionUiUnavailable();
        captured.assertActive();
      },
      assertCurrent: () => check(captured.assertCurrent),
      assertTransactionCurrent: () => {
        if (captured.transaction === undefined) selectionUiUnavailable();
        return check(captured.transaction.assertCurrent);
      },
    });
    const check = async (current: () => Promise<void>) => {
      try {
        authority.assertActive();
        await current();
        authority.assertActive();
        const answer: unknown = await this.#authorize(invocation);
        if (answer !== undefined) selectionUiUnavailable();
        authority.assertActive();
        await current();
        authority.assertActive();
      } catch (error) {
        active = false;
        throw error;
      }
    };
    this.#pending++;
    try {
      await authority.assertCurrent();
      const request = snapshot.request;
      let value: unknown;
      const mutation =
        request.action ===
        "crewon.project-generation-selections.v1.selectConceptImage";
      if (
        request.action ===
        "crewon.project-generation-selections.v1.getConceptSelection"
      ) {
        value = projectConceptSelection(
          await this.#get(context.actor, request.input, {
            authority: {
              assertCurrent: authority.assertCurrent,
              assertActive: authority.assertActive,
            },
          }),
        );
        await authority.assertCurrent();
      } else {
        if (captured.transaction === undefined) selectionUiUnavailable();
        value = projectConceptImageSelection(
          await this.#select(context.actor, request.input, {
            authority,
            source: {
              kind: "installed-plugin-ui",
              publication: {
                publication: { source: publication },
                sourcePin: captured.transaction.pin,
                selection: captured.transaction.selection,
                package: captured.transaction.package,
              },
            },
          }),
        );
      }
      const output = parsePluginUiJsonValue(
        parseProjectGenerationSelectionUiActionResponse(request, value),
        { maxBytes: MAX_PROJECT_GENERATION_SELECTION_BYTES },
      );
      if (selectionUiSnapshot(invocation).fingerprint !== snapshot.fingerprint)
        throw new ApplicationError(
          "internal",
          "plugin_project_generation_selection_context_changed",
        );
      if (!mutation) return output;
      const outcome = Object.freeze(
        Object.create(outcomePrototype),
      ) as PluginUiCommittedMetadataOutcome;
      this.#outcomes.set(
        outcome,
        Object.freeze({
          context: invocation,
          fingerprint: snapshot.fingerprint,
          output,
        }),
      );
      return outcome;
    } finally {
      this.#pending--;
      if (this.#pending === 0) this.#finishClose?.();
    }
  }
  #verify(
    context: PluginUiActionContext,
    outcome: PluginUiCommittedMetadataOutcome,
  ): PluginUiJsonValue {
    try {
      const entry = this.#outcomes.get(outcome);
      this.#outcomes.delete(outcome);
      if (
        entry === undefined ||
        entry.context !== context ||
        selectionUiSnapshot(context).fingerprint !== entry.fingerprint
      )
        throw new Error("project_generation_selection_outcome_invalid");
      return entry.output;
    } catch (cause) {
      throw new ApplicationError(
        "internal",
        "plugin_ui_committed_metadata_invalid",
        { cause },
      );
    }
  }
}

/** Private capability membership is preserved; neither owner can verify the other's receipt. */
export function combineSelectionCommittedMetadata(
  selection: PluginUiCommittedMetadataPort,
  metadata?: PluginUiCommittedMetadataPort,
): PluginUiCommittedMetadataPort {
  const ports = [selection, ...(metadata === undefined ? [] : [metadata])].map(
    (port) => ({
      isOutcome: selectionUiMethod(port, "isOutcome"),
      verify: selectionUiMethod(port, "verify"),
    }),
  );
  return Object.freeze({
    isOutcome: (value: unknown): value is PluginUiCommittedMetadataOutcome =>
      ports.some((port) => port.isOutcome(value)),
    verify: (
      context: PluginUiActionContext,
      outcome: PluginUiCommittedMetadataOutcome,
    ) => {
      const port = ports.find((item) => item.isOutcome(outcome));
      if (port === undefined)
        throw new ApplicationError(
          "internal",
          "plugin_ui_committed_metadata_invalid",
        );
      return port.verify(context, outcome);
    },
  });
}
