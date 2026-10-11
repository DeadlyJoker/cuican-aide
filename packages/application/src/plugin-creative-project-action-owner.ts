import {
  capturePluginProjectReadScope,
  type PluginProjectReadOptions,
} from "./plugin-project-read-scope.ts";
import {
  MAX_CREATIVE_PROJECT_RESPONSE_BYTES,
  formatCreativeProjectCursor,
  parseCreativeProjectListQuery,
} from "@crewon/contracts";
import {
  CREATIVE_PROJECT_UI_ACTIONS,
  CREWON_CREATIVE_PROJECTS_SERVICE,
  CREWON_CREATIVE_PROJECTS_API_VERSION,
  parseCreativeProjectUiActionRequest,
  parseCreativeProjectUiActionResponse,
  parsePluginUiJsonValue,
  type CreativeProjectUiActionRequest,
} from "@crewon/contracts/plugins";
import {
  pluginInstallationDigest,
  pluginInstallationNamespaceId,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import { CreativeProjectApplicationService } from "./creative-project-application-service.ts";
import type {
  CreativeProjectCommitAuthority,
  CreativeProjectMutationResult,
} from "./creative-project-store-port.ts";
import { capturePluginUiInvocationCommitAuthority } from "./plugin-ui-invocation-authority.ts";
import {
  capturePluginProjectCreationScope,
  type PluginProjectCreationScope,
} from "./plugin-project-creation-scope.ts";
import type {
  PluginUiActionContext,
  PluginUiActionPort,
  PluginUiCommittedMetadataOutcome,
  PluginUiCommittedMetadataPort,
  PluginUiJsonValue,
} from "./plugin-ui-ports.ts";
import {
  uiActor,
  uiEpoch,
  uiInvokeCommand,
  uiPackage,
  uiProfile,
  uiPublicLease,
  uiRecord,
  uiSelection,
} from "./plugin-ui-application-support.ts";
import {
  creativeActionAsset,
  creativeActionBrief,
  creativeActionMutation,
  creativeActionPage,
  creativeActionProject,
  creativeActionRevision,
} from "./plugin-creative-project-action-projection.ts";

export type PluginCreativeProjectActionPublication = Readonly<{
  pluginId: string;
  packageDigest: string;
  contributionId: string;
}>;
export interface PluginCreativeProjectActionAuthorizationPort {
  /** Host checks its approved installation/module readiness; this never grants project or Run policy. */
  authorize(
    context: PluginUiActionContext,
    request: CreativeProjectUiActionRequest,
  ): Promise<void>;
}
export type PluginCreativeProjectActionOwnerDependencies = Readonly<{
  projects: CreativeProjectApplicationService;
  publications: readonly PluginCreativeProjectActionPublication[];
  authorization: PluginCreativeProjectActionAuthorizationPort;
  creationOwnership?: "plugin-project-v1";
}>;
type VerifiedMetadata = Readonly<{
  context: PluginUiActionContext;
  fingerprint: string;
  output: PluginUiJsonValue;
}>;
type DispatchResult =
  | Readonly<{ kind: "metadata"; result: CreativeProjectMutationResult }>
  | Readonly<{ kind: "read"; output: unknown }>;
const actualOwners = new WeakSet<object>();
const supportedActions = new Set<string>(CREATIVE_PROJECT_UI_ACTIONS);
// An unrecognized opaque outcome cannot silently become ordinary JSON, even without its owner port.
const outcomePrototype = Object.freeze(Object.create(null) as object);

export function isPluginCreativeProjectActionOwner(
  value: unknown,
): value is PluginCreativeProjectActionOwner {
  return value !== null && typeof value === "object" && actualOwners.has(value);
}

/**
 * Host-owned dispatcher borrowing one actual metadata Service. Only this dispatcher's completed
 * mutation path can issue a receipt; no public API accepts a claimed commit or arbitrary JSON.
 */
export class PluginCreativeProjectActionOwner {
  readonly actions: PluginUiActionPort;
  readonly committedMetadata: PluginUiCommittedMetadataPort;
  readonly #publications: readonly PluginCreativeProjectActionPublication[];
  readonly #authorize: PluginCreativeProjectActionAuthorizationPort["authorize"];
  readonly #projects: ReturnType<typeof captureProjects>;
  readonly #ownsCreatedProjects: boolean;
  readonly #outcomes = new WeakMap<object, VerifiedMetadata>();
  #closed = false;
  #pending = 0;
  #closePromise: Promise<void> | undefined;
  #finishClose: (() => void) | undefined;

  constructor(dependencies: PluginCreativeProjectActionOwnerDependencies) {
    try {
      const value = uiRecord(dependencies, [
        "projects",
        "publications",
        "authorization",
        ...(Object.hasOwn(dependencies, "creationOwnership")
          ? ["creationOwnership"]
          : []),
      ]);
      if (
        value.creationOwnership !== undefined &&
        value.creationOwnership !== "plugin-project-v1"
      )
        throw new Error("plugin_project_creation_mode_invalid");
      this.#ownsCreatedProjects =
        value.creationOwnership === "plugin-project-v1";
      this.#projects = captureProjects(value.projects);
      this.#publications = capturePublications(value.publications);
      this.#authorize = captureAuthorization(value.authorization);
    } catch (cause) {
      throw new ApplicationError(
        "internal",
        "plugin_creative_project_config_invalid",
        { cause },
      );
    }
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
    return typeof action === "string" && supportedActions.has(action);
  }

  assertAvailable(): void {
    if (this.#closed)
      throw new ApplicationError(
        "authorization",
        "plugin_creative_project_actions_unavailable",
      );
  }

  /** Withdraw synchronously, then join actual in-flight calls before the Host closes their shared Store. */
  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    this.#closePromise =
      this.#pending === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            this.#finishClose = resolve;
          });
    return this.#closePromise;
  }

  async #invoke(invocation: PluginUiActionContext) {
    this.assertAvailable();
    // Membership is checked before reading caller-owned fields. Structurally valid contexts are insufficient.
    const invocationAuthority =
      capturePluginUiInvocationCommitAuthority(invocation);
    const snapshot = snapshotContext(invocation);
    this.#assertPublication(snapshot.context);
    let request: CreativeProjectUiActionRequest;
    try {
      request = parseCreativeProjectUiActionRequest({
        action: snapshot.context.action,
        input: snapshot.context.input,
      });
    } catch (cause) {
      throw new ApplicationError(
        "validation",
        "plugin_creative_project_action_invalid",
        { cause },
      );
    }
    let active = true;
    const check = async (current: () => Promise<void>) => {
      try {
        authority.assertActive();
        await current();
        authority.assertActive();
        // The production authorizer revalidates the current HTTP identity/profile using external ports.
        const result: unknown = await this.#authorize(invocation, request);
        if (result !== undefined)
          throw new ApplicationError(
            "authorization",
            "plugin_creative_project_authorization_invalid",
          );
        authority.assertActive();
        await current();
        authority.assertActive();
      } catch (error) {
        active = false;
        if (error instanceof ApplicationError) throw error;
        throw new ApplicationError(
          "authorization",
          "plugin_creative_project_action_denied",
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
            "plugin_creative_project_invocation_unavailable",
          );
        invocationAuthority.assertActive();
      },
      assertCurrent: () => check(invocationAuthority.assertCurrent),
      ...(invocationAuthority.transaction === undefined
        ? {}
        : {
            transaction: Object.freeze({
              ...invocationAuthority.transaction,
              assertCurrent: () =>
                check(invocationAuthority.transaction!.assertCurrent),
            }),
          }),
    });
    this.#pending++;
    try {
      await authority.assertCurrent();
      const dispatched = await this.#dispatch(
        snapshot.context,
        request,
        authority,
        this.#ownsCreatedProjects &&
          request.action === "crewon.creative-projects.v1.createProject"
          ? capturePluginProjectCreationScope(invocation)
          : undefined,
        this.#ownsCreatedProjects && request.action.match(/\.(get|list)/u)
          ? Object.freeze({
              readScope: capturePluginProjectReadScope(invocation, authority),
            })
          : undefined,
      );
      if (dispatched.kind === "read") await authority.assertCurrent();
      // A mutation Service returns only after confirmed COMMIT (or a checked durable replay).
      // No current-authority check follows that return: receipt delivery must not become a retry signal.
      const output = parsePluginUiJsonValue(
        parseCreativeProjectUiActionResponse(
          request,
          dispatched.kind === "metadata"
            ? creativeActionMutation(dispatched.result)
            : dispatched.output,
        ),
        { maxBytes: MAX_CREATIVE_PROJECT_RESPONSE_BYTES },
      );
      if (snapshotContext(invocation).fingerprint !== snapshot.fingerprint)
        throw new ApplicationError(
          "internal",
          "plugin_creative_project_context_changed",
        );
      if (dispatched.kind === "read") return output;
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
      const entry =
        outcome !== null && typeof outcome === "object"
          ? this.#outcomes.get(outcome)
          : undefined;
      if (entry === undefined)
        throw new Error("plugin_creative_project_outcome_unknown");
      // A failed cross-context attempt consumes the capability too.
      this.#outcomes.delete(outcome);
      if (
        entry.context !== context ||
        snapshotContext(context).fingerprint !== entry.fingerprint
      )
        throw new Error("plugin_creative_project_outcome_context_invalid");
      return entry.output;
    } catch (cause) {
      throw new ApplicationError(
        "internal",
        "plugin_ui_committed_metadata_invalid",
        { cause },
      );
    }
  }

  #assertPublication(context: PluginUiActionContext): void {
    const descriptor = context.lease.descriptor;
    const contribution = descriptor.contributions.find(
      (item) => item.id === context.lease.contributionId,
    );
    const dualEntry =
      descriptor.entrypoints.node !== null &&
      descriptor.businessManifestPath !== null;
    if (
      !this.#publications.some(
        (item) =>
          item.pluginId === descriptor.pluginId &&
          item.packageDigest === context.package.packageDigest &&
          item.contributionId === context.lease.contributionId,
      ) ||
      contribution?.kind !== "module" ||
      contribution.slot !== "main.content" ||
      !descriptor.requires.some(
        (item) =>
          item.service === CREWON_CREATIVE_PROJECTS_SERVICE &&
          item.apiVersion === CREWON_CREATIVE_PROJECTS_API_VERSION &&
          (!item.optional || dualEntry),
      )
    )
      throw new ApplicationError(
        "authorization",
        "plugin_creative_project_publication_unavailable",
      );
  }

  async #dispatch(
    context: PluginUiActionContext,
    request: CreativeProjectUiActionRequest,
    authority: CreativeProjectCommitAuthority,
    creationScope?: PluginProjectCreationScope,
    readOptions?: PluginProjectReadOptions,
  ): Promise<DispatchResult> {
    const actor = context.actor;
    const options = Object.freeze({
      authority,
      ...(creationScope === undefined ? {} : { creationScope }),
    });
    switch (request.action) {
      case "crewon.creative-projects.v1.createProject":
        return {
          kind: "metadata",
          result: await this.#projects.createProject(
            actor,
            {
              ...request.input.request,
              idempotencyKey: request.input.idempotencyKey,
            },
            options,
          ),
        };
      case "crewon.creative-projects.v1.renameProject":
        return {
          kind: "metadata",
          result: await this.#projects.renameProject(
            actor,
            {
              ...request.input.request,
              projectId: request.input.projectId,
              idempotencyKey: request.input.idempotencyKey,
            },
            options,
          ),
        };
      case "crewon.creative-projects.v1.setProjectState":
        return {
          kind: "metadata",
          result: await this.#projects.setProjectState(
            actor,
            {
              ...request.input.request,
              projectId: request.input.projectId,
              idempotencyKey: request.input.idempotencyKey,
            },
            options,
          ),
        };
      case "crewon.creative-projects.v1.appendBrief":
        return {
          kind: "metadata",
          result: await this.#projects.appendBrief(
            actor,
            {
              ...request.input.request,
              projectId: request.input.projectId,
              idempotencyKey: request.input.idempotencyKey,
            },
            options,
          ),
        };
      case "crewon.creative-projects.v1.createConcept":
        return {
          kind: "metadata",
          result: await this.#projects.createConcept(
            actor,
            {
              ...request.input.request,
              projectId: request.input.projectId,
              idempotencyKey: request.input.idempotencyKey,
            },
            options,
          ),
        };
      case "crewon.creative-projects.v1.appendConceptRevision":
        return {
          kind: "metadata",
          result: await this.#projects.appendConceptRevision(
            actor,
            {
              ...request.input.request,
              projectId: request.input.projectId,
              assetId: request.input.assetId,
              idempotencyKey: request.input.idempotencyKey,
            },
            options,
          ),
        };
      case "crewon.creative-projects.v1.getProject":
        return {
          kind: "read",
          output: {
            project: creativeActionProject(
              await this.#projects.getProject(
                actor,
                request.input,
                readOptions,
              ),
            ),
          },
        };
      case "crewon.creative-projects.v1.getBrief":
        return {
          kind: "read",
          output: {
            brief: creativeActionBrief(
              await this.#projects.getBrief(actor, request.input, readOptions),
            ),
          },
        };
      case "crewon.creative-projects.v1.getConceptAsset":
        return {
          kind: "read",
          output: {
            asset: creativeActionAsset(
              await this.#projects.getConceptAsset(
                actor,
                request.input,
                readOptions,
              ),
            ),
          },
        };
      case "crewon.creative-projects.v1.getConceptRevision":
        return {
          kind: "read",
          output: {
            assetRevision: creativeActionRevision(
              await this.#projects.getConceptRevision(
                actor,
                request.input,
                readOptions,
              ),
            ),
          },
        };
      case "crewon.creative-projects.v1.listProjects": {
        const input = request.input.query;
        const query = parseCreativeProjectListQuery({
          state: input.state,
          ...(input.cursor === null ? {} : { cursor: input.cursor }),
          limit: String(input.limit),
        });
        const page = await this.#projects.listProjects(
          actor,
          query,
          readOptions,
        );
        return {
          kind: "read",
          output: creativeActionPage({
            items: page.projects.map(creativeActionProject),
            continuation: page.next,
            cursorOf: (item) => ({
              updatedAt: item.updatedAt,
              projectId: item.projectId,
            }),
            response: (projects, next) => ({
              projects,
              nextCursor:
                next === null
                  ? null
                  : formatCreativeProjectCursor(query.state, next),
            }),
          }),
        };
      }
      case "crewon.creative-projects.v1.listBriefs": {
        const query = {
          afterBriefRevision: request.input.query.afterBriefRevision!,
          limit: request.input.query.limit!,
        };
        const items = (
          await this.#projects.listBriefs(
            actor,
            {
              projectId: request.input.projectId,
              ...query,
            },
            readOptions,
          )
        ).map(creativeActionBrief);
        return {
          kind: "read",
          output: creativeActionPage({
            items,
            continuation:
              items.length === query.limit ? items.at(-1)!.briefRevision : null,
            cursorOf: (item) => item.briefRevision,
            response: (briefs, nextAfterBriefRevision) => ({
              briefs,
              nextAfterBriefRevision,
            }),
          }),
        };
      }
      case "crewon.creative-projects.v1.listConceptAssets": {
        const query = {
          afterAssetId: request.input.query.afterAssetId!,
          limit: request.input.query.limit!,
        };
        const items = (
          await this.#projects.listConceptAssets(
            actor,
            {
              projectId: request.input.projectId,
              ...query,
            },
            readOptions,
          )
        ).map(creativeActionAsset);
        return {
          kind: "read",
          output: creativeActionPage({
            items,
            continuation:
              items.length === query.limit ? items.at(-1)!.assetId : null,
            cursorOf: (item) => item.assetId,
            response: (assets, nextAfterAssetId) => ({
              assets,
              nextAfterAssetId,
            }),
          }),
        };
      }
      case "crewon.creative-projects.v1.listConceptRevisions": {
        const query = {
          afterAssetRevision: request.input.query.afterAssetRevision!,
          limit: request.input.query.limit!,
        };
        const items = (
          await this.#projects.listConceptRevisions(
            actor,
            {
              projectId: request.input.projectId,
              assetId: request.input.assetId,
              ...query,
            },
            readOptions,
          )
        ).map(creativeActionRevision);
        return {
          kind: "read",
          output: creativeActionPage({
            items,
            continuation:
              items.length === query.limit ? items.at(-1)!.assetRevision : null,
            cursorOf: (item) => item.assetRevision,
            response: (revisions, nextAfterAssetRevision) => ({
              revisions,
              nextAfterAssetRevision,
            }),
          }),
        };
      }
    }
  }
}

function snapshotContext(input: PluginUiActionContext) {
  const value = uiRecord(input, [
    "actor",
    "scope",
    "selection",
    "package",
    "lease",
    "authorityEpoch",
    "action",
    "input",
  ]);
  const actor = uiActor(value.actor as PluginUiActionContext["actor"]);
  const scope = uiProfile(value.scope, actor);
  const lease = uiPublicLease(value.lease);
  const selection = uiSelection(
    value.selection,
    scope,
    lease.descriptor.pluginId,
  );
  const pkg = uiPackage(value.package, scope, selection);
  const command = uiInvokeCommand({
    mountRef: lease.mountRef,
    action: value.action,
    input: value.input,
  });
  if (
    selection.state !== "enabled" ||
    selection.revision !== lease.selectionRevision ||
    pkg.packageDigest !== lease.packageDigest ||
    pkg.version !== lease.descriptor.version ||
    pkg.publisherId !== lease.descriptor.publisherId
  )
    throw new ApplicationError(
      "authorization",
      "plugin_creative_project_context_invalid",
    );
  const context: PluginUiActionContext = Object.freeze({
    actor,
    scope,
    selection,
    package: pkg,
    lease,
    authorityEpoch: uiEpoch(value.authorityEpoch),
    action: command.action,
    input: command.input,
  });
  return Object.freeze({ context, fingerprint: JSON.stringify(context) });
}

function capturePublications(
  input: unknown,
): readonly PluginCreativeProjectActionPublication[] {
  if (
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    input.length === 0 ||
    input.length > 64 ||
    Reflect.ownKeys(input).length !== input.length + 1
  )
    throw new Error("plugin_creative_project_publications_invalid");
  const seen = new Set<string>();
  return Object.freeze(
    Array.from({ length: input.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
        throw new Error("plugin_creative_project_publications_invalid");
      const value = uiRecord(descriptor.value, [
        "pluginId",
        "packageDigest",
        "contributionId",
      ]);
      const publication = Object.freeze({
        pluginId: pluginInstallationNamespaceId(value.pluginId),
        packageDigest: pluginInstallationDigest(value.packageDigest),
        contributionId: pluginInstallationNamespaceId(value.contributionId),
      });
      const identity = JSON.stringify(publication);
      if (seen.has(identity))
        throw new Error("plugin_creative_project_publications_duplicate");
      seen.add(identity);
      return publication;
    }),
  );
}

function captureAuthorization(
  input: unknown,
): PluginCreativeProjectActionAuthorizationPort["authorize"] {
  if (input === null || typeof input !== "object")
    throw new Error("plugin_creative_project_authorization_missing");
  for (
    let target: object | null = input;
    target !== null;
    target = Object.getPrototypeOf(target)
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(target, "authorize");
    if (descriptor === undefined) continue;
    if (
      !Object.hasOwn(descriptor, "value") ||
      typeof descriptor.value !== "function"
    )
      throw new Error("plugin_creative_project_authorization_invalid");
    return descriptor.value.bind(
      input,
    ) as PluginCreativeProjectActionAuthorizationPort["authorize"];
  }
  throw new Error("plugin_creative_project_authorization_missing");
}

/** Bind actual class implementations once; a caller cannot swap in an arbitrary claimed commit method. */
function captureProjects(input: unknown) {
  if (!(input instanceof CreativeProjectApplicationService))
    throw new Error("plugin_creative_project_service_invalid");
  const prototype = CreativeProjectApplicationService.prototype;
  return Object.freeze({
    createProject: prototype.createProject.bind(input),
    renameProject: prototype.renameProject.bind(input),
    setProjectState: prototype.setProjectState.bind(input),
    appendBrief: prototype.appendBrief.bind(input),
    createConcept: prototype.createConcept.bind(input),
    appendConceptRevision: prototype.appendConceptRevision.bind(input),
    getProject: prototype.getProject.bind(input),
    listProjects: prototype.listProjects.bind(input),
    getBrief: prototype.getBrief.bind(input),
    listBriefs: prototype.listBriefs.bind(input),
    getConceptAsset: prototype.getConceptAsset.bind(input),
    listConceptAssets: prototype.listConceptAssets.bind(input),
    getConceptRevision: prototype.getConceptRevision.bind(input),
    listConceptRevisions: prototype.listConceptRevisions.bind(input),
  });
}
