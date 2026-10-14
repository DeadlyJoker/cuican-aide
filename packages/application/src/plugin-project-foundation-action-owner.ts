import { capturePluginProjectFoundationScope } from "./plugin-project-foundation-scope.ts";
import {
  CREWON_PROJECT_FOUNDATION_SERVICE,
  CREWON_PROJECT_FOUNDATION_API_VERSION,
  isProjectFoundationUiAction,
  isProjectFoundationUiMutationAction,
  MAX_PROJECT_FOUNDATION_UI_RESPONSE_BYTES,
  projectFoundationUiCodec,
  type ProjectFoundationUiRequest,
} from "@crewon/contracts/project-foundation";
import { parsePluginUiJsonValue } from "@crewon/contracts/plugins";
import { ApplicationError } from "./application-error.ts";
import {
  ProjectFoundationApplicationService,
  isProjectFoundationApplicationService,
} from "./project-foundation-application-service.ts";
import { capturePluginProjectFoundationInvocation } from "./plugin-project-foundation-invocation.ts";
import { projectFoundationActionContext } from "./plugin-project-foundation-action-context.ts";
import {
  captureFoundationAuthorization,
  captureFoundationActiveAuthorization,
  captureFoundationPublications,
} from "./plugin-project-foundation-action-owner-config.ts";
import {
  foundationActionFoundation,
  foundationActionMutation,
  foundationActionSource,
  foundationActionChapter,
  foundationActionProposal,
  foundationActionPage,
} from "./plugin-project-foundation-action-projection.ts";
import { uiRecord } from "./plugin-ui-application-support.ts";
import type { ProjectFoundationCommitAuthority } from "./project-foundation-store-port.ts";
import type {
  PluginUiActionContext,
  PluginUiActionPort,
  PluginUiCommittedMetadataOutcome,
  PluginUiCommittedMetadataPort,
  PluginUiJsonValue,
} from "./plugin-ui-ports.ts";
export type PluginProjectFoundationActionPublication = Readonly<{
  pluginId: string;
  packageDigest: string;
  contributionId: string;
}>;
export interface PluginProjectFoundationActionAuthorizationPort {
  /** External identity/profile/policy only; never borrow the committing Store's connection. */
  authorize(
    context: PluginUiActionContext,
    request: ProjectFoundationUiRequest,
  ): Promise<void>;
  /** Optional live external check at the Store's final synchronous COMMIT fence. */
  assertActive?(
    context: PluginUiActionContext,
    request: ProjectFoundationUiRequest,
  ): void;
}
export type PluginProjectFoundationActionOwnerDependencies = Readonly<{
  foundations: ProjectFoundationApplicationService;
  creationOwnership?: "plugin-project-v1";
  publications: readonly PluginProjectFoundationActionPublication[];
  authorization: PluginProjectFoundationActionAuthorizationPort;
}>;
type Outcome = Readonly<{
  context: PluginUiActionContext;
  fingerprint: string;
  output: PluginUiJsonValue;
}>;
const actualOwners = new WeakSet<object>();
const outcomePrototype = Object.freeze(Object.create(null) as object);
export function isPluginProjectFoundationActionOwner(
  input: unknown,
): input is PluginProjectFoundationActionOwner {
  return input !== null && typeof input === "object" && actualOwners.has(input);
}
/** Original installed UI -> genuine Foundation Service. No task, Run or supplier execution is granted. */
export class PluginProjectFoundationActionOwner {
  readonly actions: PluginUiActionPort;
  readonly committedMetadata: PluginUiCommittedMetadataPort;
  readonly #creationOwnership: boolean;
  readonly #foundations: ReturnType<typeof captureFoundations>;
  readonly #publications: readonly PluginProjectFoundationActionPublication[];
  readonly #authorize: PluginProjectFoundationActionAuthorizationPort["authorize"];
  readonly #assertAuthorizationActive: PluginProjectFoundationActionAuthorizationPort["assertActive"];
  readonly #outcomes = new WeakMap<object, Outcome>();
  #closed = false;
  #pending = 0;
  #closing: Promise<void> | undefined;
  #finishClose: (() => void) | undefined;
  constructor(input: PluginProjectFoundationActionOwnerDependencies) {
    try {
      const value = uiRecord(input, [
        "foundations",
        ...(Object.hasOwn(input, "creationOwnership")
          ? ["creationOwnership"]
          : []),
        "publications",
        "authorization",
      ]);
      if (
        value.creationOwnership !== undefined &&
        value.creationOwnership !== "plugin-project-v1"
      )
        throw new Error("plugin_project_foundation_ownership_invalid");
      this.#creationOwnership = value.creationOwnership === "plugin-project-v1";
      this.#foundations = captureFoundations(value.foundations);
      this.#publications = captureFoundationPublications(value.publications);
      this.#authorize = captureFoundationAuthorization(value.authorization);
      this.#assertAuthorizationActive = captureFoundationActiveAuthorization(
        value.authorization,
      );
    } catch (cause) {
      throw new ApplicationError(
        "internal",
        "plugin_project_foundation_config_invalid",
        { cause },
      );
    }
    this.actions = Object.freeze({
      invoke: (context: PluginUiActionContext) => this.#invoke(context),
    });
    this.committedMetadata = Object.freeze({
      isOutcome: (value: unknown): value is PluginUiCommittedMetadataOutcome =>
        value !== null &&
        typeof value === "object" &&
        this.#outcomes.has(value),
      verify: (
        context: PluginUiActionContext,
        outcome: PluginUiCommittedMetadataOutcome,
      ) => this.#verify(context, outcome),
    });
    actualOwners.add(this);
    Object.freeze(this);
  }
  supportsAction(action: string): boolean {
    return isProjectFoundationUiAction(action);
  }
  assertAvailable(): void {
    if (this.#closed)
      throw new ApplicationError(
        "authorization",
        "plugin_project_foundation_actions_unavailable",
      );
  }
  /** Withdraw synchronously and join all pending actions before the shared parent Store closes. */
  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    this.#closed = true;
    return (this.#closing =
      this.#pending === 0
        ? Promise.resolve()
        : new Promise((resolve) => {
            this.#finishClose = resolve;
          }));
  }
  async #invoke(invocation: PluginUiActionContext) {
    this.assertAvailable();
    if (this.#pending >= 64)
      throw new ApplicationError(
        "conflict",
        "plugin_project_foundation_inflight_limit",
      );
    // Private membership is checked before any caller-supplied field or getter is inspected.
    const original = capturePluginProjectFoundationInvocation(invocation);
    const snapshot = original.snapshot;
    this.#assertPublication(snapshot.context);
    const request = snapshot.request;
    if (
      isProjectFoundationUiMutationAction(request.action) &&
      original.transaction === undefined
    )
      throw new ApplicationError(
        "authorization",
        "plugin_project_foundation_invocation_unavailable",
      );
    let active = true;
    const check = async (current: () => Promise<void>) => {
      try {
        authority.assertActive();
        await current();
        authority.assertActive();
        const result: unknown = await this.#authorize(invocation, request);
        if (result !== undefined)
          throw new ApplicationError(
            "authorization",
            "plugin_project_foundation_authorization_invalid",
          );
        authority.assertActive();
        await current();
        authority.assertActive();
      } catch (error) {
        active = false;
        if (error instanceof ApplicationError) throw error;
        throw new ApplicationError(
          "authorization",
          "plugin_project_foundation_action_denied",
          { cause: error },
        );
      }
    };
    const authority: ProjectFoundationCommitAuthority = Object.freeze({
      assertActive: () => {
        this.assertAvailable();
        if (!active)
          throw new ApplicationError(
            "authorization",
            "plugin_project_foundation_invocation_unavailable",
          );
        original.assertActive();
        try {
          const result: unknown = this.#assertAuthorizationActive?.(
            invocation,
            request,
          );
          if (result !== undefined) {
            if (
              result !== null &&
              (typeof result === "object" || typeof result === "function")
            )
              try {
                void Promise.prototype.then.call(
                  result,
                  () => undefined,
                  () => undefined,
                );
              } catch {
                // Observe native rejection without inspecting a caller-owned then property.
              }
            throw new ApplicationError(
              "authorization",
              "plugin_project_foundation_authorization_invalid",
            );
          }
        } catch (error) {
          active = false;
          if (error instanceof ApplicationError) throw error;
          throw new ApplicationError(
            "authorization",
            "plugin_project_foundation_action_denied",
            { cause: error },
          );
        }
      },
      assertCurrent: () => check(original.assertCurrent),
      ...(original.transaction === undefined
        ? {}
        : {
            transaction: Object.freeze({
              ...original.transaction,
              assertCurrent: () => check(original.transaction!.assertCurrent),
            }),
          }),
    });
    this.#pending++;
    try {
      await authority.assertCurrent();
      const result = await this.#dispatch(invocation, request, authority);
      if (result.kind === "read") await authority.assertCurrent();
      const output = parsePluginUiJsonValue(
        projectFoundationUiCodec.parseResponse(result.output, request),
        { maxBytes: MAX_PROJECT_FOUNDATION_UI_RESPONSE_BYTES },
      );
      if (
        projectFoundationActionContext(invocation).fingerprint !==
        snapshot.fingerprint
      )
        throw new ApplicationError(
          "internal",
          "plugin_project_foundation_context_changed",
        );
      if (result.kind === "read") return output;
      // Only a genuine service return after a confirmed commit or checked durable replay creates this receipt.
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
    const entry =
      outcome !== null && typeof outcome === "object"
        ? this.#outcomes.get(outcome)
        : undefined;
    this.#outcomes.delete(outcome);
    if (
      entry === undefined ||
      entry.context !== context ||
      projectFoundationActionContext(context).fingerprint !== entry.fingerprint
    )
      throw new ApplicationError(
        "internal",
        "plugin_ui_committed_metadata_invalid",
      );
    return entry.output;
  }
  #assertPublication(context: PluginUiActionContext): void {
    const descriptor = context.lease.descriptor;
    const contribution = descriptor.contributions.find(
      (value) => value.id === context.lease.contributionId,
    );
    const dualEntry =
      descriptor.entrypoints.node !== null &&
      descriptor.businessManifestPath !== null;
    if (
      !this.#publications.some(
        (value) =>
          value.pluginId === descriptor.pluginId &&
          value.packageDigest === context.package.packageDigest &&
          value.contributionId === context.lease.contributionId,
      ) ||
      contribution?.kind !== "module" ||
      contribution.slot !== "main.content" ||
      !descriptor.requires.some(
        (value) =>
          value.service === CREWON_PROJECT_FOUNDATION_SERVICE &&
          value.apiVersion === CREWON_PROJECT_FOUNDATION_API_VERSION &&
          (!value.optional || dualEntry),
      )
    )
      throw new ApplicationError(
        "authorization",
        "plugin_project_foundation_publication_unavailable",
      );
  }
  async #dispatch(
    context: PluginUiActionContext,
    request: ProjectFoundationUiRequest,
    authority: ProjectFoundationCommitAuthority,
  ): Promise<Readonly<{ kind: "read" | "metadata"; output: unknown }>> {
    const projectScope = this.#creationOwnership
      ? capturePluginProjectFoundationScope(context, authority)
      : undefined;
    const foundations =
      projectScope === undefined
        ? this.#foundations
        : captureFoundations(
            this.#foundations.bindPluginProjectScope(projectScope),
          );
    const actor = context.actor,
      options = Object.freeze({
        authority,
        ...(projectScope === undefined ? {} : { projectScope }),
      });
    switch (request.action) {
      case "crewon.project-foundation.v1.createProject":
        return {
          kind: "metadata",
          output: foundationActionMutation(
            await foundations.createProject(actor, request.input, options),
          ),
        };
      case "crewon.project-foundation.v1.updateParameters":
        return {
          kind: "metadata",
          output: foundationActionMutation(
            await foundations.updateParameters(actor, request.input, options),
          ),
        };
      case "crewon.project-foundation.v1.appendSource":
        return {
          kind: "metadata",
          output: foundationActionMutation(
            await foundations.appendSource(actor, request.input, options),
          ),
        };
      case "crewon.project-foundation.v1.saveProposal":
        return {
          kind: "metadata",
          output: foundationActionMutation(
            await foundations.saveProposal(actor, request.input, options),
          ),
        };
      case "crewon.project-foundation.v1.confirmProposal":
        return {
          kind: "metadata",
          output: foundationActionMutation(
            await foundations.confirmProposal(actor, request.input, options),
          ),
        };
      case "crewon.project-foundation.v1.chooseDirectScript":
        return {
          kind: "metadata",
          output: foundationActionMutation(
            await foundations.chooseCreativeStartMode(
              actor,
              request.input,
              options,
            ),
          ),
        };
      case "crewon.project-foundation.v1.getFoundation": {
        const value = await foundations.getFoundation(actor, request.input);
        return {
          kind: "read",
          output: {
            foundation:
              value === null ? null : foundationActionFoundation(value),
          },
        };
      }
      case "crewon.project-foundation.v1.getSource": {
        const value = await foundations.getSource(actor, request.input);
        return {
          kind: "read",
          output: {
            source: value === null ? null : foundationActionSource(value),
          },
        };
      }
      case "crewon.project-foundation.v1.readSourcePage":
        return {
          kind: "read",
          output: {
            page: await foundations.readSourcePage(actor, request.input),
          },
        };
      case "crewon.project-foundation.v1.listSourceChapters": {
        const value = await foundations.listSourceChapters(
          actor,
          request.input,
        );
        return {
          kind: "read",
          output: foundationActionPage({
            items: value.chapters.map(foundationActionChapter),
            continuation: value.nextStartOffset,
            cursorOf: (chapter) => chapter.startOffset,
            response: (chapters, nextStartOffset) => ({
              chapters,
              nextStartOffset,
            }),
          }),
        };
      }
      case "crewon.project-foundation.v1.getProposal": {
        const value = await foundations.getProposal(actor, request.input);
        return {
          kind: "read",
          output: {
            proposal: value === null ? null : foundationActionProposal(value),
          },
        };
      }
      case "crewon.project-foundation.v1.listProposals": {
        const value = await foundations.listProposals(actor, request.input);
        return {
          kind: "read",
          output: foundationActionPage({
            items: value.proposals.map(foundationActionProposal),
            continuation: value.nextRevision,
            cursorOf: (proposal) => proposal.revision,
            response: (proposals, nextRevision) => ({
              proposals,
              nextRevision,
            }),
          }),
        };
      }
    }
  }
}
function captureFoundations(input: unknown) {
  if (!isProjectFoundationApplicationService(input))
    throw new Error("plugin_project_foundation_service_invalid");
  const proto = ProjectFoundationApplicationService.prototype;
  return Object.freeze({
    bindPluginProjectScope: proto.bindPluginProjectScope.bind(input),
    createProject: proto.createProject.bind(input),
    updateParameters: proto.updateParameters.bind(input),
    appendSource: proto.appendSource.bind(input),
    saveProposal: proto.saveProposal.bind(input),
    confirmProposal: proto.confirmProposal.bind(input),
    chooseCreativeStartMode: proto.chooseCreativeStartMode.bind(input),
    getFoundation: proto.getFoundation.bind(input),
    getSource: proto.getSource.bind(input),
    readSourcePage: proto.readSourcePage.bind(input),
    listSourceChapters: proto.listSourceChapters.bind(input),
    getProposal: proto.getProposal.bind(input),
    listProposals: proto.listProposals.bind(input),
  });
}
