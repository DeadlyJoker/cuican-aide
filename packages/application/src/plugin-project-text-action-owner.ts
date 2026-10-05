import {
  CREWON_PROJECT_TEXTS_SERVICE,
  CREWON_PROJECT_TEXTS_API_VERSION,
  isProjectTextUiAction,
  parseProjectTextUiActionResponse,
  MAX_PROJECT_TEXT_UI_RESPONSE_BYTES,
  type ProjectTextUiActionRequest,
} from "@crewon/contracts/project-texts-ui";
import { parsePluginUiJsonValue } from "@crewon/contracts/plugins";
import {
  pluginInstallationDigest,
  pluginInstallationNamespaceId,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import { ProjectTextApplicationService } from "./project-text-application-service.ts";
import { capturePluginProjectTextUiInvocationCommitAuthority } from "./plugin-ui-invocation-authority.ts";
import {
  PluginProjectTextRecoveryApplicationService,
  isPluginProjectTextRecoveryApplicationService,
} from "./plugin-project-text-recovery-application-service.ts";
import { projectTextActionContext } from "./plugin-project-text-action-context.ts";
import { uiRecord } from "./plugin-ui-application-support.ts";
import type { CreativeProjectCommitAuthority } from "./creative-project-store-port.ts";
import type {
  PluginUiActionContext,
  PluginUiActionPort,
  PluginUiCommittedMetadataOutcome,
  PluginUiCommittedMetadataPort,
  PluginUiJsonValue,
} from "./plugin-ui-ports.ts";
import {
  textActionArtifact,
  textActionMutation,
  textActionPage,
  textActionRevision,
  textActionView,
} from "./plugin-project-text-action-projection.ts";

export type PluginProjectTextActionPublication = Readonly<{
  pluginId: string;
  packageDigest: string;
  contributionId: string;
}>;
export interface PluginProjectTextActionAuthorizationPort {
  /** External identity/profile/policy only. It must not borrow the committing Store's pool. */
  authorize(
    context: PluginUiActionContext,
    request: ProjectTextUiActionRequest,
  ): Promise<void>;
}
export type PluginProjectTextActionOwnerDependencies = Readonly<{
  texts: ProjectTextApplicationService;
  publications: readonly PluginProjectTextActionPublication[];
  authorization: PluginProjectTextActionAuthorizationPort;
  recovery?: PluginProjectTextRecoveryApplicationService;
}>;
type Outcome = Readonly<{
  context: PluginUiActionContext;
  fingerprint: string;
  output: PluginUiJsonValue;
}>;
const actualOwners = new WeakSet<object>();
const outcomePrototype = Object.freeze(Object.create(null) as object);
export function isPluginProjectTextActionOwner(
  input: unknown,
): input is PluginProjectTextActionOwner {
  return input !== null && typeof input === "object" && actualOwners.has(input);
}

/** Genuine text Service and actual UI invocation. This owner cannot launch a Run or manufacture a commit. */
export class PluginProjectTextActionOwner {
  readonly actions: PluginUiActionPort;
  readonly committedMetadata: PluginUiCommittedMetadataPort;
  readonly #texts: ReturnType<typeof captureTexts>;
  readonly #publications: readonly PluginProjectTextActionPublication[];
  readonly #authorize: PluginProjectTextActionAuthorizationPort["authorize"];
  readonly #recovery:
    | Readonly<{
        supports: PluginProjectTextRecoveryApplicationService["supports"];
        stage: PluginProjectTextRecoveryApplicationService["stage"];
        observeFailure: PluginProjectTextRecoveryApplicationService["observeFailure"];
      }>
    | undefined;
  readonly #outcomes = new WeakMap<object, Outcome>();
  #closed = false;
  #pending = 0;
  #closing: Promise<void> | undefined;
  #finishClose: (() => void) | undefined;
  constructor(input: PluginProjectTextActionOwnerDependencies) {
    try {
      const value = uiRecord(input, [
        "texts",
        "publications",
        "authorization",
        ...(Object.hasOwn(input, "recovery") ? ["recovery"] : []),
      ]);
      this.#texts = captureTexts(value.texts);
      this.#publications = captureProjectTextPublications(value.publications);
      this.#authorize = captureAuthorization(value.authorization);
      if (value.recovery !== undefined) {
        if (!isPluginProjectTextRecoveryApplicationService(value.recovery))
          throw new Error("plugin_project_text_recovery_config_invalid");
        const proto = PluginProjectTextRecoveryApplicationService.prototype;
        this.#recovery = Object.freeze({
          supports: proto.supports.bind(value.recovery),
          stage: proto.stage.bind(value.recovery),
          observeFailure: proto.observeFailure.bind(value.recovery),
        });
      }
    } catch (cause) {
      throw new ApplicationError(
        "internal",
        "plugin_project_text_config_invalid",
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
    return isProjectTextUiAction(action);
  }
  assertAvailable(): void {
    if (this.#closed)
      throw new ApplicationError(
        "authorization",
        "plugin_project_text_actions_unavailable",
      );
  }
  /** Withdraw synchronously; physically join calls before their shared parent Store is closed. */
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
        "plugin_project_text_inflight_limit",
      );
    // Exact private membership is established before inspecting caller-supplied fields.
    const original =
      capturePluginProjectTextUiInvocationCommitAuthority(invocation);
    const snapshot = projectTextActionContext(invocation);
    this.#assertPublication(snapshot.context);
    const request = snapshot.request;
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
            "plugin_project_text_authorization_invalid",
          );
        authority.assertActive();
        await current();
        authority.assertActive();
      } catch (error) {
        active = false;
        if (error instanceof ApplicationError) throw error;
        throw new ApplicationError(
          "authorization",
          "plugin_project_text_action_denied",
          { cause: error },
        );
      }
    };
    const authority: CreativeProjectCommitAuthority = Object.freeze({
      assertActive: () => {
        this.assertAvailable();
        if (!active)
          throw new ApplicationError(
            "authorization",
            "plugin_ui_invocation_unavailable",
          );
        original.assertActive();
      },
      assertCurrent: () => check(original.assertCurrent),
      ...(original.textUiTransaction === undefined
        ? {}
        : {
            textUiTransaction: Object.freeze({
              ...original.textUiTransaction,
              assertCurrent: () =>
                check(original.textUiTransaction!.assertCurrent),
            }),
          }),
    });
    this.#pending++;
    try {
      await authority.assertCurrent();
      const journal =
        this.#recovery !== undefined &&
        original.textUiTransaction !== undefined &&
        this.#recovery.supports(snapshot.context)
          ? this.#recovery
          : undefined;
      const committedAuthority =
        journal === undefined
          ? authority
          : await journal.stage(invocation, authority);
      let result: Readonly<{ kind: "read" | "metadata"; output: unknown }>;
      try {
        result = await this.#dispatch(
          snapshot.context,
          request,
          committedAuthority,
        );
      } catch (error) {
        if (journal !== undefined)
          try {
            await journal.observeFailure(invocation, committedAuthority, error);
          } catch {
            /* Unknown journal outcome never replaces the original business error or clears pending. */
          }
        throw error;
      }
      if (result.kind === "read") await authority.assertCurrent();
      // The finite text/content bounds guarantee a single write acknowledgement fits this budget.
      const output = parsePluginUiJsonValue(
        parseProjectTextUiActionResponse(request, result.output),
        { maxBytes: MAX_PROJECT_TEXT_UI_RESPONSE_BYTES },
      );
      if (
        projectTextActionContext(invocation).fingerprint !==
        snapshot.fingerprint
      )
        throw new ApplicationError(
          "internal",
          "plugin_project_text_context_changed",
        );
      if (result.kind === "read") return output;
      // Only a genuine Service return after COMMIT or checked durable replay issues this opaque receipt.
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
      projectTextActionContext(context).fingerprint !== entry.fingerprint
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
          value.service === CREWON_PROJECT_TEXTS_SERVICE &&
          value.apiVersion === CREWON_PROJECT_TEXTS_API_VERSION &&
          (!value.optional || dualEntry),
      )
    )
      throw new ApplicationError(
        "authorization",
        "plugin_project_text_publication_unavailable",
      );
  }
  async #dispatch(
    context: PluginUiActionContext,
    request: ProjectTextUiActionRequest,
    authority: CreativeProjectCommitAuthority,
  ): Promise<Readonly<{ kind: "read" | "metadata"; output: unknown }>> {
    const actor = context.actor,
      options = Object.freeze({ authority });
    switch (request.action) {
      case "crewon.project-texts.v1.getOutline":
        return {
          kind: "read",
          output: {
            view: textActionView(
              await this.#texts.getOutline(actor, request.input),
            ),
          },
        };
      case "crewon.project-texts.v1.getScript":
        return {
          kind: "read",
          output: {
            view: textActionView(
              await this.#texts.getScript(actor, request.input),
            ),
          },
        };
      case "crewon.project-texts.v1.getArtifact":
        return {
          kind: "read",
          output: {
            view: textActionView(
              await this.#texts.getArtifact(actor, request.input),
            ),
          },
        };
      case "crewon.project-texts.v1.getRevision":
        return {
          kind: "read",
          output: {
            contentRevision: textActionRevision(
              await this.#texts.getRevision(actor, request.input),
            ),
          },
        };
      case "crewon.project-texts.v1.listArtifacts": {
        const page = await this.#texts.listArtifacts(actor, request.input);
        return {
          kind: "read",
          output: textActionPage({
            items: page.artifacts.map(textActionArtifact),
            continuation: page.nextArtifactId,
            cursorOf: (value) => value.artifactId,
            response: (artifacts, nextArtifactId) => ({
              artifacts,
              nextArtifactId,
            }),
          }),
        };
      }
      case "crewon.project-texts.v1.listRevisions": {
        const page = await this.#texts.listRevisions(actor, request.input);
        return {
          kind: "read",
          output: textActionPage({
            items: page.revisions.map(textActionRevision),
            continuation: page.nextContentRevision,
            cursorOf: (value) => value.contentRevision,
            response: (revisions, nextContentRevision) => ({
              revisions,
              nextContentRevision,
            }),
          }),
        };
      }
      case "crewon.project-texts.v1.saveOutlineCandidate":
        return {
          kind: "metadata",
          output: textActionMutation(
            await this.#texts.saveOutlineCandidate(
              actor,
              {
                projectId: request.input.projectId,
                ...request.input.request,
                idempotencyKey: request.input.idempotencyKey,
              },
              options,
            ),
          ),
        };
      case "crewon.project-texts.v1.saveScriptCandidate":
        return {
          kind: "metadata",
          output: textActionMutation(
            await this.#texts.saveScriptCandidate(
              actor,
              {
                projectId: request.input.projectId,
                episodeId: request.input.episodeId,
                ...request.input.request,
                idempotencyKey: request.input.idempotencyKey,
              },
              options,
            ),
          ),
        };
      case "crewon.project-texts.v1.selectRevision":
        return {
          kind: "metadata",
          output: textActionMutation(
            await this.#texts.selectRevision(
              actor,
              {
                projectId: request.input.projectId,
                artifactId: request.input.artifactId,
                ...request.input.request,
                idempotencyKey: request.input.idempotencyKey,
              },
              options,
            ),
          ),
        };
      case "crewon.project-texts.v1.setLocked":
        return {
          kind: "metadata",
          output: textActionMutation(
            await this.#texts.setLocked(
              actor,
              {
                projectId: request.input.projectId,
                artifactId: request.input.artifactId,
                ...request.input.request,
                idempotencyKey: request.input.idempotencyKey,
              },
              options,
            ),
          ),
        };
    }
  }
}
function captureTexts(input: unknown) {
  if (!(input instanceof ProjectTextApplicationService))
    throw new Error("plugin_project_text_service_invalid");
  const proto = ProjectTextApplicationService.prototype;
  return Object.freeze({
    getOutline: proto.getOutline.bind(input),
    getScript: proto.getScript.bind(input),
    getArtifact: proto.getArtifact.bind(input),
    getRevision: proto.getRevision.bind(input),
    listArtifacts: proto.listArtifacts.bind(input),
    listRevisions: proto.listRevisions.bind(input),
    saveOutlineCandidate: proto.saveOutlineCandidate.bind(input),
    saveScriptCandidate: proto.saveScriptCandidate.bind(input),
    selectRevision: proto.selectRevision.bind(input),
    setLocked: proto.setLocked.bind(input),
  });
}
export function captureProjectTextPublications(
  input: unknown,
): readonly PluginProjectTextActionPublication[] {
  if (
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    input.length < 1 ||
    input.length > 32 ||
    Reflect.ownKeys(input).length !== input.length + 1
  )
    throw new Error("plugin_project_text_publications_invalid");
  const seen = new Set<string>();
  return Object.freeze(
    Array.from({ length: input.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
        throw new Error("plugin_project_text_publications_invalid");
      const value = uiRecord(descriptor.value, [
        "pluginId",
        "packageDigest",
        "contributionId",
      ]);
      const result = Object.freeze({
        pluginId: pluginInstallationNamespaceId(value.pluginId),
        packageDigest: pluginInstallationDigest(value.packageDigest),
        contributionId: pluginInstallationNamespaceId(value.contributionId),
      });
      const key = JSON.stringify(result);
      if (seen.has(key))
        throw new Error("plugin_project_text_publication_duplicate");
      seen.add(key);
      return result;
    }),
  );
}
function captureAuthorization(
  input: unknown,
): PluginProjectTextActionAuthorizationPort["authorize"] {
  if (input === null || typeof input !== "object")
    throw new Error("plugin_project_text_authorization_invalid");
  let target: object | null = input;
  for (
    let depth = 0;
    target !== null && depth < 16;
    depth++, target = Object.getPrototypeOf(target)
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(target, "authorize");
    if (descriptor === undefined) continue;
    if (
      !Object.hasOwn(descriptor, "value") ||
      typeof descriptor.value !== "function"
    )
      break;
    return descriptor.value.bind(
      input,
    ) as PluginProjectTextActionAuthorizationPort["authorize"];
  }
  throw new Error("plugin_project_text_authorization_invalid");
}
