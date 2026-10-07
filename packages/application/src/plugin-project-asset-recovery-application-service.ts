import {
  parseProjectAssetUiIntent,
  parseProjectAssetUiIntentScope,
  assertProjectAssetUiIntentScope,
  extensionCanonicalJson,
  creativeProjectTimestamp,
  creativeProjectDigest,
  PROJECT_ASSET_UI_INTENT_REFUSAL_CODES,
  type ProjectAssetUiIntent,
  type ProjectAssetUiIntentScope,
  type ProjectAssetUiIntentRefusalCode,
} from "@crewon/domain";
import {
  parseProjectAssetRecoveryActionResponse,
  CREWON_PROJECT_ASSET_RECOVERY_SERVICE,
  CREWON_PROJECT_ASSET_RECOVERY_API_VERSION,
  type ProjectAssetRecoveryPendingResponse,
  type ProjectAssetRecoveryAcknowledgementResponse,
} from "@crewon/contracts/project-asset-recovery";
import { isProjectAssetUiMutationAction } from "@crewon/contracts/project-assets";
import { ApplicationError } from "./application-error.ts";
import type {
  ApplicationClock,
  ContentDigester,
} from "./application-runtime-ports.ts";
import type { CreativeProjectAuthorizationPort } from "./creative-project-authorization-port.ts";
import type { CreativeProjectStore } from "./creative-project-store-port.ts";
import type { ProjectAssetUiIntentJournalStore } from "./project-asset-ui-intent-journal-store-port.ts";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";
import {
  captureProjectAssetRecoveryCommitAuthority,
  type ProjectAssetRecoveryCommitAuthority,
} from "./project-asset-recovery-commit-authority.ts";
import {
  captureProjectAssetCommitAuthority,
  type ProjectAssetCommitAuthority,
} from "./project-asset-commit-authority.ts";
import { projectAssetUiMutationCommand } from "./project-asset-ui-commit-authority.ts";
import { projectAssetActionContext } from "./plugin-project-asset-action-context.ts";
import { projectAssetRecoveryContext } from "./plugin-project-asset-recovery-context.ts";
import { capturePluginProjectAssetInvocationCommitAuthority } from "./plugin-project-asset-invocation.ts";
import { capturePluginProjectAssetRecoveryInvocationCommitAuthority } from "./plugin-project-asset-recovery-invocation.ts";
import {
  captureProjectTextPublications,
  type PluginProjectTextActionPublication,
} from "./plugin-project-text-action-owner.ts";
import {
  checkedCreativeProject,
  creativeOwner,
} from "./creative-project-application-support.ts";
import { projectAssetMutationReceipt } from "./project-asset-application-support.ts";
import { uiRecord } from "./plugin-ui-application-support.ts";

export type PluginProjectAssetRecoveryApplicationDependencies = Readonly<{
  journal: ProjectAssetUiIntentJournalStore;
  projects: Pick<CreativeProjectStore, "loadProject">;
  authorization: CreativeProjectAuthorizationPort;
  publications: readonly PluginProjectTextActionPublication[];
  clock: ApplicationClock;
  digester: ContentDigester;
}>;
const services = new WeakSet<object>();
export function isPluginProjectAssetRecoveryApplicationService(
  input: unknown,
): input is PluginProjectAssetRecoveryApplicationService {
  return input !== null && typeof input === "object" && services.has(input);
}
/** Genuine manual intents only: the cross-project slot never grants a Run or an asset write. */
export class PluginProjectAssetRecoveryApplicationService {
  readonly #d: PluginProjectAssetRecoveryApplicationDependencies;
  readonly #publications: readonly PluginProjectTextActionPublication[];
  constructor(input: PluginProjectAssetRecoveryApplicationDependencies) {
    const v = uiRecord(input, [
      "journal",
      "projects",
      "authorization",
      "publications",
      "clock",
      "digester",
    ]);
    this.#publications = captureProjectTextPublications(v.publications);
    const journal = v.journal as ProjectAssetUiIntentJournalStore,
      projects =
        v.projects as PluginProjectAssetRecoveryApplicationDependencies["projects"],
      authorization = v.authorization as CreativeProjectAuthorizationPort,
      clock = v.clock as ApplicationClock,
      digester = v.digester as ContentDigester;
    this.#d = Object.freeze({
      publications: this.#publications,
      journal: Object.freeze({
        migrate: method(journal, "migrate"),
        stage: method(journal, "stage"),
        getPending: method(journal, "getPending"),
        loadIntent: method(journal, "loadIntent"),
        acknowledge: method(journal, "acknowledge"),
        observeRejected: method(journal, "observeRejected"),
      }),
      projects: Object.freeze({ loadProject: method(projects, "loadProject") }),
      authorization: Object.freeze({
        authorize: method(authorization, "authorize"),
      }),
      clock: Object.freeze({ now: method(clock, "now") }),
      digester: Object.freeze({ sha256: method(digester, "sha256") }),
    });
    services.add(this);
    Object.freeze(this);
  }
  supports(context: PluginUiActionContext): boolean {
    return this.#publications.some(
      (p) =>
        p.pluginId === context.package.pluginId &&
        p.packageDigest === context.package.packageDigest &&
        p.contributionId === context.lease.contributionId,
    );
  }
  async stage(
    context: PluginUiActionContext,
    input: ProjectAssetCommitAuthority,
  ): Promise<ProjectAssetCommitAuthority> {
    const original =
        capturePluginProjectAssetInvocationCommitAuthority(context),
      snapshot = projectAssetActionContext(context);
    this.#publication(snapshot.context);
    if (
      !isProjectAssetUiMutationAction(snapshot.request.action) ||
      original.uiTransaction === undefined
    )
      denied();
    const authority = captureProjectAssetCommitAuthority({ authority: input }),
      tx = authority?.uiTransaction;
    if (
      tx === undefined ||
      tx.version !== "crewon.project-asset-plugin-commit.v1" ||
      !isProjectAssetUiMutationAction(tx.actionId) ||
      !sameTransaction(tx, original.uiTransaction)
    )
      denied();
    const actionId = tx.actionId,
      scope = scopeOf(snapshot.context, snapshot.installation),
      projectId = snapshot.request.input.projectId,
      { kind, command } = projectAssetUiMutationCommand(tx);
    const receipt = projectAssetMutationReceipt(
        scope.actor,
        kind,
        command,
        this.#d.digester,
      ),
      digest = creativeProjectDigest(receipt.requestDigest);
    const intentId = `asset-intent-${creativeProjectDigest(this.#d.digester.sha256(extensionCanonicalJson({ scope, actionId: tx.actionId, idempotencyKey: receipt.idempotencyKey, requestDigest: digest }))).slice(7)}`;
    const qualified = this.#assetPolicy(
      scope,
      projectId,
      Object.freeze({
        ...authority!,
        uiTransaction: Object.freeze({
          ...tx,
          intentRef: Object.freeze({ intentId, requestDigest: digest }),
        }),
      }),
    );
    // Maximum terminal metadata overhead must fit before the original intent is persisted.
    publicRecord({
      schemaVersion: "crewon.project-asset-ui-intent.v1",
      scope,
      projectId,
      intentId,
      revision: 1,
      phase: "accepted",
      actionId: tx.actionId,
      input: snapshot.request.input,
      requestDigest: digest,
      createdAt: this.#at(),
      updatedAt: this.#at(),
      acknowledgedAt: null,
      receipt: {
        kind,
        idempotencyKey: receipt.idempotencyKey,
        requestDigest: digest,
        resultDigest: digest,
        assetId: command.assetId ?? "a".repeat(128),
        assetRevision: command.expectedAssetRevision + 1,
        contentRevision:
          kind === "save-content"
            ? Number.MAX_SAFE_INTEGER
            : kind === "select-content" && "contentRevision" in command
              ? command.contentRevision
              : null,
        referenceRevision:
          kind === "save-reference"
            ? Number.MAX_SAFE_INTEGER
            : kind === "select-reference" && "referenceRevision" in command
              ? command.referenceRevision
              : null,
      },
      refusalCode: null,
    });
    await qualified.assertCurrent();
    await this.#ownedProject(scope, projectId);
    const staged = stored(
      await journalOperation(() =>
        this.#d.journal.stage(
          {
            scope,
            actionId,
            input: snapshot.request.input,
            intentId,
            at: this.#at(),
          },
          { authority: qualified },
        ),
      ),
      scope,
    );
    if (
      staged.projectId !== projectId ||
      staged.actionId !== tx.actionId ||
      extensionCanonicalJson(staged.input) !==
        extensionCanonicalJson(snapshot.request.input) ||
      staged.requestDigest !== digest
    )
      invalidStore();
    await qualified.assertCurrent();
    if (staged.phase === "refused")
      throw new ApplicationError("conflict", staged.refusalCode!);
    return Object.freeze({
      ...qualified,
      uiTransaction: Object.freeze({
        ...qualified.uiTransaction!,
        intentRef: Object.freeze({
          intentId: staged.intentId,
          requestDigest: staged.requestDigest,
        }),
      }),
    });
  }
  async observeFailure(
    context: PluginUiActionContext,
    input: ProjectAssetCommitAuthority,
    error: unknown,
  ): Promise<void> {
    if (
      !(error instanceof ApplicationError) ||
      !PROJECT_ASSET_UI_INTENT_REFUSAL_CODES.includes(
        error.code as ProjectAssetUiIntentRefusalCode,
      )
    )
      return;
    const original =
        capturePluginProjectAssetInvocationCommitAuthority(context),
      snapshot = projectAssetActionContext(context);
    this.#publication(snapshot.context);
    const authority = captureProjectAssetCommitAuthority({ authority: input }),
      tx = authority?.uiTransaction;
    if (
      tx?.intentRef === undefined ||
      original.uiTransaction === undefined ||
      !sameTransaction(tx, original.uiTransaction)
    )
      denied();
    const scope = scopeOf(snapshot.context, snapshot.installation),
      qualified = this.#assetPolicy(
        scope,
        snapshot.request.input.projectId,
        authority!,
      );
    await qualified.assertCurrent();
    const result = stored(
      await journalOperation(() =>
        this.#d.journal.observeRejected(
          {
            scope,
            intentId: tx.intentRef!.intentId,
            at: this.#at(),
            code: error.code as ProjectAssetUiIntentRefusalCode,
          },
          { authority: qualified },
        ),
      ),
      scope,
    );
    if (
      result.intentId !== tx.intentRef.intentId ||
      result.requestDigest !== tx.intentRef.requestDigest
    )
      invalidStore();
  }
  async getPending(
    context: PluginUiActionContext,
    input: ProjectAssetRecoveryCommitAuthority,
  ): Promise<ProjectAssetRecoveryPendingResponse> {
    const { snapshot, scope, authority } = this.#recovery(context, input);
    if (
      snapshot.request.action !== "crewon.project-asset-recovery.v1.getPending"
    )
      denied();
    await authority.assertCurrent();
    const value = await journalOperation(() =>
      this.#d.journal.getPending({ scope }, { authority }),
    );
    if (value === null) {
      await authority.assertCurrent();
      return Object.freeze({ intent: null });
    }
    const record = stored(value, scope);
    if (record.acknowledgedAt !== null) invalidStore();
    await this.#policy(scope, record.projectId, "creativeProject:read");
    await this.#ownedProject(scope, record.projectId);
    await authority.assertCurrent();
    return publicRecord(record);
  }
  async acknowledge(
    context: PluginUiActionContext,
    input: ProjectAssetRecoveryCommitAuthority,
  ): Promise<ProjectAssetRecoveryAcknowledgementResponse> {
    const {
      snapshot,
      scope,
      authority: original,
    } = this.#recovery(context, input);
    if (
      snapshot.request.action !== "crewon.project-asset-recovery.v1.acknowledge"
    )
      denied();
    const request = snapshot.request.input;
    await original.assertCurrent();
    // Private exact-scope read includes ACK tombstones so replay still authorizes its actual project.
    const raw = await journalOperation(() =>
      this.#d.journal.loadIntent(
        { scope, intentId: request.intentId },
        { authority: original },
      ),
    );
    if (raw === null)
      throw new ApplicationError(
        "notFound",
        "project_asset_ui_intent_not_found",
      );
    const record = stored(raw, scope);
    if (record.intentId !== request.intentId) invalidStore();
    const authority = this.#recoveryPolicy(scope, record.projectId, original);
    await authority.assertCurrent();
    await this.#ownedProject(scope, record.projectId);
    const result = await journalOperation(() =>
      this.#d.journal.acknowledge(
        {
          scope,
          intentId: request.intentId,
          expectedRevision: request.expectedRevision,
          at: this.#at(),
        },
        { authority },
      ),
    );
    const intent = stored(result.intent, scope);
    if (
      intent.intentId !== request.intentId ||
      intent.projectId !== record.projectId ||
      intent.acknowledgedAt === null ||
      intent.phase === "pending"
    )
      invalidStore();
    // Confirmed physical COMMIT/replayed ACK remains confirmed after a later disposal.
    return parseProjectAssetRecoveryActionResponse(snapshot.request, {
      intentId: intent.intentId,
      revision: intent.revision,
      disposition: result.disposition,
    }) as ProjectAssetRecoveryAcknowledgementResponse;
  }
  #recovery(
    context: PluginUiActionContext,
    input: ProjectAssetRecoveryCommitAuthority,
  ) {
    const original =
        capturePluginProjectAssetRecoveryInvocationCommitAuthority(context),
      snapshot = projectAssetRecoveryContext(context);
    this.#publication(snapshot.context);
    const authority = captureProjectAssetRecoveryCommitAuthority(input);
    if (
      extensionCanonicalJson({
        ...authority.recoveryTransaction,
        assertCurrent: null,
      }) !==
      extensionCanonicalJson({
        ...original.recoveryTransaction,
        assertCurrent: null,
      })
    )
      denied();
    return {
      snapshot,
      scope: scopeOf(snapshot.context, snapshot.installation),
      authority,
    };
  }
  #assetPolicy(
    scope: ProjectAssetUiIntentScope,
    projectId: string,
    authority: ProjectAssetCommitAuthority,
  ): ProjectAssetCommitAuthority {
    const fence = async (current: () => Promise<void>) => {
      authority.assertActive();
      await this.#policy(scope, projectId, "creativeProject:write");
      await current();
      authority.assertActive();
    };
    return Object.freeze({
      ...authority,
      assertCurrent: () => fence(authority.assertCurrent),
      assertTransactionCurrent: () => fence(authority.assertTransactionCurrent),
      uiTransaction: Object.freeze({
        ...authority.uiTransaction!,
        assertCurrent: () => fence(authority.uiTransaction!.assertCurrent),
      }),
    });
  }
  #recoveryPolicy(
    scope: ProjectAssetUiIntentScope,
    projectId: string,
    authority: ProjectAssetRecoveryCommitAuthority,
  ): ProjectAssetRecoveryCommitAuthority {
    const fence = async (current: () => Promise<void>) => {
      authority.assertActive();
      await this.#policy(scope, projectId, "creativeProject:write");
      await current();
      authority.assertActive();
    };
    return Object.freeze({
      ...authority,
      assertCurrent: () => fence(authority.assertCurrent),
      assertTransactionCurrent: () => fence(authority.assertTransactionCurrent),
      recoveryTransaction: Object.freeze({
        ...authority.recoveryTransaction,
        assertCurrent: () => fence(authority.recoveryTransaction.assertCurrent),
      }),
    });
  }
  #publication(context: PluginUiActionContext) {
    const d = context.lease.descriptor,
      c = d.contributions.find((v) => v.id === context.lease.contributionId);
    if (
      !this.supports(context) ||
      c?.kind !== "module" ||
      c.slot !== "main.content" ||
      !d.requires.some(
        (v) =>
          v.service === CREWON_PROJECT_ASSET_RECOVERY_SERVICE &&
          v.apiVersion === CREWON_PROJECT_ASSET_RECOVERY_API_VERSION &&
          (!v.optional ||
            (d.entrypoints.node !== null && d.businessManifestPath !== null)),
      )
    )
      denied();
  }
  async #policy(
    scope: ProjectAssetUiIntentScope,
    projectId: string,
    action: "creativeProject:read" | "creativeProject:write",
  ) {
    const value = await this.#d.authorization.authorize({
      actor: scope.actor,
      action,
      resource: {
        kind: "creativeProject",
        tenantId: scope.actor.tenantId,
        spaceId: scope.actor.spaceId,
        projectId,
      },
    });
    try {
      if (uiRecord(value, ["outcome"]).outcome !== "allow")
        throw new Error("deny");
    } catch {
      throw new ApplicationError(
        "authorization",
        "creative_project_authorization_denied",
      );
    }
  }
  async #ownedProject(scope: ProjectAssetUiIntentScope, projectId: string) {
    const owner = creativeOwner(scope.actor),
      value = await this.#d.projects.loadProject({ owner, projectId });
    if (value === null)
      throw new ApplicationError("notFound", "creative_project_not_found");
    checkedCreativeProject(value, owner, projectId);
  }
  #at() {
    return creativeProjectTimestamp(this.#d.clock.now());
  }
}
function scopeOf(
  context: PluginUiActionContext,
  installation: ProjectAssetUiIntentScope["installation"],
) {
  return parseProjectAssetUiIntentScope({
    actor: context.actor,
    installation,
    contributionId: context.lease.contributionId,
  });
}
function sameTransaction(a: unknown, b: unknown) {
  return (
    extensionCanonicalJson({
      ...(a as object),
      assertCurrent: null,
      intentRef: null,
    }) ===
    extensionCanonicalJson({
      ...(b as object),
      assertCurrent: null,
      intentRef: null,
    })
  );
}
function stored(input: unknown, scope: ProjectAssetUiIntentScope) {
  try {
    const record = parseProjectAssetUiIntent(input);
    assertProjectAssetUiIntentScope(record.scope, scope);
    return record;
  } catch (cause) {
    throw new ApplicationError(
      "internal",
      "project_asset_recovery_store_invalid",
      { cause },
    );
  }
}
function publicRecord(
  record: ProjectAssetUiIntent,
): ProjectAssetRecoveryPendingResponse {
  const r = record.receipt;
  return parseProjectAssetRecoveryActionResponse(
    { action: "crewon.project-asset-recovery.v1.getPending", input: {} },
    {
      intent: {
        intentId: record.intentId,
        revision: record.revision,
        phase: record.phase,
        request: { action: record.actionId, input: record.input },
        requestDigest: record.requestDigest,
        confirmed:
          r === null
            ? null
            : {
                kind: r.kind,
                assetId: r.assetId,
                assetRevision: r.assetRevision,
                contentRevision: r.contentRevision,
                referenceRevision: r.referenceRevision,
                requestDigest: r.requestDigest,
                resultDigest: r.resultDigest,
              },
        refusalCode: record.refusalCode,
      },
    },
  ) as ProjectAssetRecoveryPendingResponse;
}
async function journalOperation<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    const code =
      error instanceof Error
        ? "code" in error && typeof error.code === "string"
          ? error.code
          : error.message
        : "";
    if (code === "project_asset_ui_intent_not_found")
      throw new ApplicationError("notFound", code, { cause: error });
    if (
      [
        "project_asset_ui_intent_pending",
        "project_asset_ui_intent_unacknowledged",
        "project_asset_ui_intent_revision_conflict",
        "project_asset_ui_intent_refused",
        "project_asset_receipt_conflict",
      ].includes(code)
    )
      throw new ApplicationError("conflict", code, { cause: error });
    throw new ApplicationError(
      "internal",
      "project_asset_recovery_store_unavailable",
      { cause: error },
    );
  }
}
function method<T extends object, K extends keyof T>(input: T, key: K): T[K] {
  if (input === null || typeof input !== "object") denied();
  for (
    let owner: object | null = input, depth = 0;
    owner !== null && depth < 16;
    owner = Object.getPrototypeOf(owner), depth++
  ) {
    const d = Object.getOwnPropertyDescriptor(owner, key);
    if (d === undefined) continue;
    if (!("value" in d) || typeof d.value !== "function") denied();
    return d.value.bind(input) as T[K];
  }
  return denied();
}
function denied(): never {
  throw new ApplicationError(
    "authorization",
    "plugin_project_asset_recovery_unavailable",
  );
}
function invalidStore(): never {
  throw new ApplicationError(
    "internal",
    "project_asset_recovery_store_invalid",
  );
}
