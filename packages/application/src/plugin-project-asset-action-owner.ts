import {
  PluginProjectAssetRecoveryApplicationService,
  isPluginProjectAssetRecoveryApplicationService,
} from "./plugin-project-asset-recovery-application-service.ts";
import {
  CREWON_PROJECT_ASSETS_SERVICE,
  CREWON_PROJECT_ASSETS_API_VERSION,
  isProjectAssetUiAction,
  isProjectAssetUiMutationAction,
  parseProjectAssetUiActionResponse,
  MAX_PROJECT_ASSET_UI_RESPONSE_BYTES,
  type ProjectAssetUiActionRequest,
} from "@crewon/contracts/project-assets";
import { parsePluginUiJsonValue } from "@crewon/contracts/plugins";
import { ApplicationError } from "./application-error.ts";
import {
  ProjectAssetApplicationService,
  isProjectAssetApplicationService,
} from "./project-asset-application-service.ts";
import { capturePluginProjectAssetInvocationCommitAuthority } from "./plugin-project-asset-invocation.ts";
import { projectAssetActionContext } from "./plugin-project-asset-action-context.ts";
import {
  captureProjectTextPublications,
  type PluginProjectTextActionPublication,
} from "./plugin-project-text-action-owner.ts";
import type { ProjectAssetCommitAuthority } from "./project-asset-commit-authority.ts";
import { projectAssetUiMutationCommand } from "./project-asset-ui-commit-authority.ts";
import type {
  SaveProjectAssetCandidateCommand,
  SelectProjectAssetRevisionCommand,
  SetProjectAssetLockedCommand,
  SaveProjectAssetReferenceCandidateCommand,
  SelectProjectAssetReferenceCommand,
} from "./project-asset-commands.ts";
import { projectAssetAuthorityFields } from "./project-asset-qualification-data.ts";
import type {
  PluginUiActionContext,
  PluginUiActionPort,
  PluginUiCommittedMetadataOutcome,
  PluginUiCommittedMetadataPort,
  PluginUiJsonValue,
} from "./plugin-ui-ports.ts";
import {
  projectAssetPublicHead,
  projectAssetPublicMutation,
  projectAssetPublicPage,
  projectAssetPublicReference,
  projectAssetPublicRevision,
  projectAssetPublicView,
} from "./plugin-project-asset-action-projection.ts";

export type PluginProjectAssetActionPublication =
  PluginProjectTextActionPublication;
export type PluginProjectAssetActionOwnerDependencies = Readonly<{
  assets: ProjectAssetApplicationService;
  recovery?: PluginProjectAssetRecoveryApplicationService;
  publications: readonly PluginProjectAssetActionPublication[];
  authorization: Readonly<{
    authorize(
      context: PluginUiActionContext,
      request: ProjectAssetUiActionRequest,
    ): Promise<void>;
  }>;
}>;
type Outcome = Readonly<{
  context: PluginUiActionContext;
  fingerprint: string;
  output: PluginUiJsonValue;
}>;
const owners = new WeakSet<object>(),
  outcomePrototype = Object.freeze(Object.create(null) as object);
export function isPluginProjectAssetActionOwner(
  input: unknown,
): input is PluginProjectAssetActionOwner {
  return input !== null && typeof input === "object" && owners.has(input);
}
/** Actual manually invoked archive service; metadata approval never becomes a Node or task grant. */
export class PluginProjectAssetActionOwner {
  readonly actions: PluginUiActionPort;
  readonly committedMetadata: PluginUiCommittedMetadataPort;
  readonly #recovery:
    | Readonly<
        Pick<
          PluginProjectAssetRecoveryApplicationService,
          "supports" | "stage" | "observeFailure"
        >
      >
    | undefined;
  readonly #assets: ReturnType<typeof captureAssets>;
  readonly #publications: readonly PluginProjectAssetActionPublication[];
  readonly #authorize: PluginProjectAssetActionOwnerDependencies["authorization"]["authorize"];
  readonly #outcomes = new WeakMap<object, Outcome>();
  #closed = false;
  #pending = 0;
  #closing: Promise<void> | undefined;
  #finishClose: (() => void) | undefined;
  constructor(input: PluginProjectAssetActionOwnerDependencies) {
    const optional = Object.hasOwn(input, "recovery");
    const v = projectAssetAuthorityFields(input, [
      "assets",
      "publications",
      "authorization",
      ...(optional ? ["recovery"] : []),
    ]);
    if (optional) {
      if (!isPluginProjectAssetRecoveryApplicationService(v.recovery))
        throw new ApplicationError(
          "internal",
          "plugin_project_asset_recovery_config_invalid",
        );
      const service = v.recovery;
      this.#recovery = Object.freeze({
        supports:
          PluginProjectAssetRecoveryApplicationService.prototype.supports.bind(
            service,
          ),
        stage:
          PluginProjectAssetRecoveryApplicationService.prototype.stage.bind(
            service,
          ),
        observeFailure:
          PluginProjectAssetRecoveryApplicationService.prototype.observeFailure.bind(
            service,
          ),
      });
    }
    this.#assets = captureAssets(v.assets);
    this.#publications = captureProjectTextPublications(v.publications);
    this.#authorize = captureAuthorization(v.authorization);
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
    owners.add(this);
    Object.freeze(this);
  }
  supportsAction(action: string): boolean {
    return isProjectAssetUiAction(action);
  }
  assertAvailable(): void {
    if (this.#closed)
      throw new ApplicationError(
        "authorization",
        "plugin_project_asset_actions_unavailable",
      );
  }
  /** Synchronous withdrawal, then physical join before the shared Store owner closes. */
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
        "plugin_project_asset_inflight_limit",
      );
    const original =
      capturePluginProjectAssetInvocationCommitAuthority(invocation);
    const snapshot = projectAssetActionContext(invocation),
      request = snapshot.request;
    this.#assertPublication(snapshot.context);
    let active = true;
    const assertActive = () => {
      this.assertAvailable();
      if (!active)
        throw new ApplicationError(
          "authorization",
          "plugin_project_asset_actions_unavailable",
        );
      original.assertActive();
    };
    const check = async (current: () => Promise<void>) => {
      try {
        assertActive();
        await current();
        assertActive();
        if ((await this.#authorize(invocation, request)) !== undefined)
          throw new Error("plugin_project_asset_authorization_invalid");
        await current();
        assertActive();
      } catch (error) {
        active = false;
        throw error;
      }
    };
    const authority: ProjectAssetCommitAuthority = Object.freeze({
      assertActive,
      assertCurrent: () => check(original.assertCurrent),
      assertTransactionCurrent: () => check(original.assertTransactionCurrent),
      ...(original.uiTransaction === undefined
        ? {}
        : {
            uiTransaction: Object.freeze({
              ...original.uiTransaction,
              assertCurrent: () => check(original.uiTransaction!.assertCurrent),
            }),
          }),
    });
    this.#pending++;
    try {
      await authority.assertCurrent();
      const journal =
        isProjectAssetUiMutationAction(request.action) &&
        this.#recovery?.supports(snapshot.context)
          ? this.#recovery
          : undefined;
      const effective =
        journal === undefined
          ? authority
          : await journal.stage(invocation, authority);
      let raw: unknown;
      try {
        raw = await this.#dispatch(snapshot.context, request, effective);
      } catch (error) {
        if (journal !== undefined)
          await journal
            .observeFailure(invocation, effective, error)
            .catch(() => undefined);
        throw error;
      }
      const write = isProjectAssetUiMutationAction(request.action);
      if (!write) await authority.assertCurrent();
      const output = parsePluginUiJsonValue(
        parseProjectAssetUiActionResponse(request, raw),
        { maxBytes: MAX_PROJECT_ASSET_UI_RESPONSE_BYTES },
      );
      if (!write) return output;
      // Only the genuine App return after atomic COMMIT/checked receipt replay issues this outcome.
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
      projectAssetActionContext(context).fingerprint !== entry.fingerprint
    )
      throw new ApplicationError(
        "internal",
        "plugin_ui_committed_metadata_invalid",
      );
    return entry.output;
  }
  #assertPublication(context: PluginUiActionContext): void {
    const descriptor = context.lease.descriptor,
      contribution = descriptor.contributions.find(
        (v) => v.id === context.lease.contributionId,
      );
    const dual =
      descriptor.entrypoints.node !== null &&
      descriptor.businessManifestPath !== null;
    if (
      !this.#publications.some(
        (v) =>
          v.pluginId === descriptor.pluginId &&
          v.packageDigest === context.package.packageDigest &&
          v.contributionId === context.lease.contributionId,
      ) ||
      contribution?.kind !== "module" ||
      contribution.slot !== "main.content" ||
      !descriptor.requires.some(
        (v) =>
          v.service === CREWON_PROJECT_ASSETS_SERVICE &&
          v.apiVersion === CREWON_PROJECT_ASSETS_API_VERSION &&
          (!v.optional || dual),
      )
    )
      throw new ApplicationError(
        "authorization",
        "plugin_project_asset_publication_unavailable",
      );
  }
  async #dispatch(
    context: PluginUiActionContext,
    request: ProjectAssetUiActionRequest,
    authority: ProjectAssetCommitAuthority,
  ): Promise<unknown> {
    const actor = context.actor;
    if (isProjectAssetUiMutationAction(request.action)) {
      if (authority.uiTransaction === undefined)
        throw new ApplicationError(
          "authorization",
          "plugin_project_asset_transaction_required",
        );
      const { command } = projectAssetUiMutationCommand(
          authority.uiTransaction,
        ),
        options = Object.freeze({ authority });
      const result =
        request.action === "crewon.project-assets.v1.saveCandidate"
          ? await this.#assets.saveCandidate(
              actor,
              command as SaveProjectAssetCandidateCommand,
              options,
            )
          : request.action === "crewon.project-assets.v1.selectRevision"
            ? await this.#assets.selectRevision(
                actor,
                command as SelectProjectAssetRevisionCommand,
                options,
              )
            : request.action === "crewon.project-assets.v1.setLocked"
              ? await this.#assets.setLocked(
                  actor,
                  command as SetProjectAssetLockedCommand,
                  options,
                )
              : request.action ===
                  "crewon.project-assets.v1.saveReferenceCandidate"
                ? await this.#assets.saveReferenceCandidate(
                    actor,
                    command as SaveProjectAssetReferenceCandidateCommand,
                    options,
                  )
                : await this.#assets.selectReference(
                    actor,
                    command as SelectProjectAssetReferenceCommand,
                    options,
                  );
      return projectAssetPublicMutation(result);
    }
    switch (request.action) {
      case "crewon.project-assets.v1.getAsset":
        return {
          view: projectAssetPublicView(
            await this.#assets.getAsset(actor, request.input),
          ),
        };
      case "crewon.project-assets.v1.getRevision":
        return {
          contentRevision: projectAssetPublicRevision(
            await this.#assets.getRevision(actor, request.input),
          ),
        };
      case "crewon.project-assets.v1.getReferenceRevision":
        return {
          referenceRevision: projectAssetPublicReference(
            await this.#assets.getReferenceRevision(actor, request.input),
          ),
        };
      case "crewon.project-assets.v1.listAssets": {
        const p = await this.#assets.listAssets(actor, {
          ...request.input,
          kind: null,
        });
        return projectAssetPublicPage({
          items: p.assets.map(projectAssetPublicHead),
          continuation: p.nextAssetId,
          cursorOf: (v) => v.assetId,
          response: (assets, nextAssetId) => ({ assets, nextAssetId }),
        });
      }
      case "crewon.project-assets.v1.listRevisions": {
        const p = await this.#assets.listRevisions(actor, request.input);
        return projectAssetPublicPage({
          items: p.revisions.map(projectAssetPublicRevision),
          continuation: p.nextContentRevision,
          cursorOf: (v) => v.contentRevision,
          response: (revisions, nextContentRevision) => ({
            revisions,
            nextContentRevision,
          }),
        });
      }
      case "crewon.project-assets.v1.listReferences": {
        const p = await this.#assets.listReferences(actor, request.input);
        return projectAssetPublicPage({
          items: p.references.map(projectAssetPublicReference),
          continuation: p.nextReferenceRevision,
          cursorOf: (v) => v.referenceRevision,
          response: (references, nextReferenceRevision) => ({
            references,
            nextReferenceRevision,
          }),
        });
      }
    }
    throw new ApplicationError(
      "validation",
      "plugin_project_asset_action_unknown",
    );
  }
}
function captureAssets(input: unknown) {
  if (!isProjectAssetApplicationService(input))
    throw new Error("plugin_project_asset_service_invalid");
  const p = ProjectAssetApplicationService.prototype;
  return Object.freeze({
    getAsset: p.getAsset.bind(input),
    getRevision: p.getRevision.bind(input),
    getReferenceRevision: p.getReferenceRevision.bind(input),
    listAssets: p.listAssets.bind(input),
    listRevisions: p.listRevisions.bind(input),
    listReferences: p.listReferences.bind(input),
    saveCandidate: p.saveCandidate.bind(input),
    selectRevision: p.selectRevision.bind(input),
    setLocked: p.setLocked.bind(input),
    saveReferenceCandidate: p.saveReferenceCandidate.bind(input),
    selectReference: p.selectReference.bind(input),
  });
}
function captureAuthorization(
  input: unknown,
): PluginProjectAssetActionOwnerDependencies["authorization"]["authorize"] {
  if (input === null || typeof input !== "object")
    throw new Error("plugin_project_asset_authorization_invalid");
  for (
    let owner: object | null = input, depth = 0;
    owner !== null && depth < 16;
    owner = Object.getPrototypeOf(owner), depth++
  ) {
    const d = Object.getOwnPropertyDescriptor(owner, "authorize");
    if (d === undefined) continue;
    if (!Object.hasOwn(d, "value") || typeof d.value !== "function") break;
    return d.value.bind(
      input,
    ) as PluginProjectAssetActionOwnerDependencies["authorization"]["authorize"];
  }
  throw new Error("plugin_project_asset_authorization_invalid");
}
