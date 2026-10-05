import {
  parseProjectTextUiIntent,
  parseProjectTextUiIntentScope,
  assertProjectTextUiIntentScope,
  extensionCanonicalJson,
  creativeProjectTimestamp,
  creativeProjectDigest,
  PROJECT_TEXT_UI_INTENT_REFUSAL_CODES,
  type ProjectTextUiIntent,
  type ProjectTextUiIntentScope,
  type ProjectTextUiIntentRefusalCode,
} from "@crewon/domain";
import {
  parseProjectTextRecoveryActionResponse,
  CREWON_PROJECT_TEXT_RECOVERY_SERVICE,
  CREWON_PROJECT_TEXT_RECOVERY_API_VERSION,
  type ProjectTextRecoveryPendingResponse,
  type ProjectTextRecoveryAcknowledgementResponse,
} from "@crewon/contracts/project-text-recovery";
import { isProjectTextUiMutationAction } from "@crewon/contracts/project-texts-ui";
import { ApplicationError } from "./application-error.ts";
import type {
  ApplicationClock,
  ApplicationIdGenerator,
  ContentDigester,
} from "./application-runtime-ports.ts";
import type { CreativeProjectAuthorizationPort } from "./creative-project-authorization-port.ts";
import type {
  CreativeProjectStore,
  CreativeProjectCommitAuthority,
} from "./creative-project-store-port.ts";
import type { ProjectTextUiIntentJournalStore } from "./project-text-ui-intent-journal-store-port.ts";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";
import type { ProjectTextRecoveryCommitAuthority } from "./project-text-recovery-commit-authority.ts";
import { captureProjectTextRecoveryCommitAuthority } from "./project-text-recovery-commit-authority.ts";
import { captureCreativeProjectCommitAuthority } from "./creative-project-commit-authority.ts";
import { projectTextUiMutationCommand } from "./project-text-ui-commit-authority.ts";
import { projectTextActionContext } from "./plugin-project-text-action-context.ts";
import { projectTextRecoveryContext } from "./plugin-project-text-recovery-context.ts";
import {
  capturePluginProjectTextUiInvocationCommitAuthority,
  capturePluginProjectTextRecoveryInvocationCommitAuthority,
} from "./plugin-ui-invocation-authority.ts";
import {
  captureProjectTextPublications,
  type PluginProjectTextActionPublication,
} from "./plugin-project-text-action-owner.ts";
import {
  checkedCreativeProject,
  creativeOwner,
} from "./creative-project-application-support.ts";
import { uiRecord } from "./plugin-ui-application-support.ts";

export type PluginProjectTextRecoveryApplicationDependencies = Readonly<{
  journal: ProjectTextUiIntentJournalStore;
  projects: Pick<CreativeProjectStore, "loadProject">;
  authorization: CreativeProjectAuthorizationPort;
  publications: readonly PluginProjectTextActionPublication[];
  clock: ApplicationClock;
  ids: ApplicationIdGenerator;
  digester: ContentDigester;
}>;
const services = new WeakSet<object>();
export function isPluginProjectTextRecoveryApplicationService(
  input: unknown,
): input is PluginProjectTextRecoveryApplicationService {
  return input !== null && typeof input === "object" && services.has(input);
}

/** Private staging and public read/ACK, always using genuine UI evidence and independent project PDP. */
export class PluginProjectTextRecoveryApplicationService {
  readonly #dependencies: PluginProjectTextRecoveryApplicationDependencies;
  readonly #publications: readonly PluginProjectTextActionPublication[];
  constructor(input: PluginProjectTextRecoveryApplicationDependencies) {
    const fields = uiRecord(input, [
      "journal",
      "projects",
      "authorization",
      "publications",
      "clock",
      "ids",
      "digester",
    ]);
    this.#publications = captureProjectTextPublications(fields.publications);
    const journal = fields.journal as ProjectTextUiIntentJournalStore;
    const projects =
      fields.projects as PluginProjectTextRecoveryApplicationDependencies["projects"];
    const authorization =
      fields.authorization as CreativeProjectAuthorizationPort;
    const clock = fields.clock as ApplicationClock,
      ids = fields.ids as ApplicationIdGenerator,
      digester = fields.digester as ContentDigester;
    this.#dependencies = Object.freeze({
      publications: this.#publications,
      journal: Object.freeze({
        migrate: method(journal, "migrate"),
        stage: method(journal, "stage"),
        getPending: method(journal, "getPending"),
        acknowledge: method(journal, "acknowledge"),
        observeRejected: method(journal, "observeRejected"),
      }),
      projects: Object.freeze({ loadProject: method(projects, "loadProject") }),
      authorization: Object.freeze({
        authorize: method(authorization, "authorize"),
      }),
      clock: Object.freeze({ now: method(clock, "now") }),
      ids: Object.freeze({ nextId: method(ids, "nextId") }),
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
    input: CreativeProjectCommitAuthority,
  ): Promise<CreativeProjectCommitAuthority> {
    // A JSON copy, text ACK, Run grant or a setup call cannot enter the automatic staging path.
    const original =
        capturePluginProjectTextUiInvocationCommitAuthority(context),
      snapshot = projectTextActionContext(context);
    this.#publication(snapshot.context);
    if (
      !isProjectTextUiMutationAction(snapshot.request.action) ||
      original.textUiTransaction === undefined
    )
      denied();
    const authority = captureCreativeProjectCommitAuthority(
      { authority: input },
      { allowTextUiTransaction: true },
    );
    const tx = authority?.textUiTransaction;
    if (
      tx === undefined ||
      extensionCanonicalJson({
        ...tx,
        assertCurrent: null,
        intentRef: null,
      }) !==
        extensionCanonicalJson({
          ...original.textUiTransaction,
          assertCurrent: null,
          intentRef: null,
        })
    )
      denied();
    const scope = scopeOf(
      snapshot.context,
      snapshot.installation,
      snapshot.request.input.projectId,
    );
    const receipt = projectTextUiMutationCommand(
      tx,
      this.#dependencies.digester,
    ).receipt;
    const digest = creativeProjectDigest(receipt.requestDigest);
    const intentId = `text-intent-${creativeProjectDigest(this.#dependencies.digester.sha256(extensionCanonicalJson({ scope, actionId: tx.actionId, idempotencyKey: receipt.idempotencyKey, requestDigest: digest }))).slice(7)}`;
    const qualified = this.#textPolicy(
      scope,
      Object.freeze({
        ...authority!,
        textUiTransaction: Object.freeze({
          ...tx,
          contributionId: scope.contributionId,
          intentRef: Object.freeze({ intentId, requestDigest: digest }),
        }),
      }),
    );
    // Prove the recovered full body fits before persisting a new intent, including terminal metadata overhead.
    publicRecord({
      schemaVersion: "crewon.project-text-ui-intent.v1",
      scope,
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
        kind: projectTextUiMutationCommand(tx, this.#dependencies.digester)
          .kind,
        idempotencyKey: receipt.idempotencyKey,
        requestDigest: digest,
        resultDigest: digest,
        artifactId:
          "artifactId" in snapshot.request.input
            ? snapshot.request.input.artifactId
            : "a".repeat(128),
        artifactRevision: Number.MAX_SAFE_INTEGER,
        contentRevision:
          snapshot.request.action === "crewon.project-texts.v1.setLocked"
            ? null
            : snapshot.request.action ===
                "crewon.project-texts.v1.selectRevision"
              ? snapshot.request.input.request.contentRevision
              : Number.MAX_SAFE_INTEGER,
      },
      refusalCode: null,
    });
    await qualified.assertCurrent();
    await this.#ownedProject(scope);
    const staged = stored(
      await journalOperation(() =>
        this.#dependencies.journal.stage(
          {
            scope,
            actionId: tx.actionId,
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
      textUiTransaction: Object.freeze({
        ...qualified.textUiTransaction!,
        intentRef: Object.freeze({
          intentId: staged.intentId,
          requestDigest: staged.requestDigest,
        }),
      }),
    });
  }
  async observeFailure(
    context: PluginUiActionContext,
    input: CreativeProjectCommitAuthority,
    error: unknown,
  ): Promise<void> {
    if (
      !(error instanceof ApplicationError) ||
      !PROJECT_TEXT_UI_INTENT_REFUSAL_CODES.includes(
        error.code as ProjectTextUiIntentRefusalCode,
      )
    )
      return;
    const original =
        capturePluginProjectTextUiInvocationCommitAuthority(context),
      snapshot = projectTextActionContext(context);
    if (original.textUiTransaction === undefined) denied();
    this.#publication(snapshot.context);
    const authority = captureCreativeProjectCommitAuthority(
      { authority: input },
      { allowTextUiTransaction: true },
    );
    const tx = authority?.textUiTransaction;
    if (
      tx?.intentRef === undefined ||
      extensionCanonicalJson({
        ...tx,
        assertCurrent: null,
        intentRef: null,
      }) !==
        extensionCanonicalJson({
          ...original.textUiTransaction,
          assertCurrent: null,
          intentRef: null,
        })
    )
      denied();
    const scope = scopeOf(
        snapshot.context,
        snapshot.installation,
        snapshot.request.input.projectId,
      ),
      qualified = this.#textPolicy(scope, authority!);
    await qualified.assertCurrent();
    const result = stored(
      await this.#dependencies.journal.observeRejected(
        {
          scope,
          intentId: tx.intentRef.intentId,
          at: this.#at(),
          code: error.code as ProjectTextUiIntentRefusalCode,
        },
        { authority: qualified },
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
    input: ProjectTextRecoveryCommitAuthority,
  ): Promise<ProjectTextRecoveryPendingResponse> {
    const { snapshot, scope, authority } = this.#recovery(
      context,
      input,
      "creativeProject:read",
    );
    await authority.assertCurrent();
    await this.#ownedProject(scope);
    const value = await journalOperation(() =>
      this.#dependencies.journal.getPending({ scope }, { authority }),
    );
    await authority.assertCurrent();
    return parseProjectTextRecoveryActionResponse(
      snapshot.request,
      value === null ? { intent: null } : publicRecord(stored(value, scope)),
    ) as ProjectTextRecoveryPendingResponse;
  }
  async acknowledge(
    context: PluginUiActionContext,
    input: ProjectTextRecoveryCommitAuthority,
  ): Promise<ProjectTextRecoveryAcknowledgementResponse> {
    const { snapshot, scope, authority } = this.#recovery(
      context,
      input,
      "creativeProject:write",
    );
    if (
      snapshot.request.action !== "crewon.project-text-recovery.v1.acknowledge"
    )
      denied();
    await authority.assertCurrent();
    await this.#ownedProject(scope);
    const request = snapshot.request.input;
    const result = await journalOperation(() =>
      this.#dependencies.journal.acknowledge(
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
      intent.acknowledgedAt === null ||
      intent.phase === "pending"
    )
      invalidStore();
    // The Store's confirmed COMMIT is returned without a late withdrawal fence.
    return parseProjectTextRecoveryActionResponse(snapshot.request, {
      intentId: intent.intentId,
      revision: intent.revision,
      disposition: result.disposition,
    }) as ProjectTextRecoveryAcknowledgementResponse;
  }
  #recovery(
    context: PluginUiActionContext,
    input: ProjectTextRecoveryCommitAuthority,
    action: "creativeProject:read" | "creativeProject:write",
  ) {
    const original =
        capturePluginProjectTextRecoveryInvocationCommitAuthority(context),
      snapshot = projectTextRecoveryContext(context);
    this.#publication(snapshot.context);
    const captured = captureProjectTextRecoveryCommitAuthority(input);
    if (
      extensionCanonicalJson({
        ...captured.recoveryTransaction,
        assertCurrent: null,
      }) !==
      extensionCanonicalJson({
        ...original.recoveryTransaction,
        assertCurrent: null,
      })
    )
      denied();
    if (
      (action === "creativeProject:read") !==
      (snapshot.request.action === "crewon.project-text-recovery.v1.getPending")
    )
      denied();
    const scope = scopeOf(
      snapshot.context,
      snapshot.installation,
      snapshot.request.input.projectId,
    );
    const policy = () => this.#policy(scope, action);
    const authority = Object.freeze({
      ...captured,
      assertCurrent: async () => {
        captured.assertActive();
        await policy();
        await captured.assertCurrent();
        captured.assertActive();
      },
      recoveryTransaction: Object.freeze({
        ...captured.recoveryTransaction,
        assertCurrent: async () => {
          captured.assertActive();
          await policy();
          await captured.recoveryTransaction.assertCurrent();
          captured.assertActive();
        },
      }),
    });
    return { snapshot, scope, authority };
  }
  #textPolicy(
    scope: ProjectTextUiIntentScope,
    authority: CreativeProjectCommitAuthority,
  ): CreativeProjectCommitAuthority {
    return Object.freeze({
      ...authority,
      assertCurrent: async () => {
        authority.assertActive();
        await this.#policy(scope, "creativeProject:write");
        await authority.assertCurrent();
        authority.assertActive();
      },
      textUiTransaction: Object.freeze({
        ...authority.textUiTransaction!,
        assertCurrent: async () => {
          authority.assertActive();
          await this.#policy(scope, "creativeProject:write");
          await authority.textUiTransaction!.assertCurrent();
          authority.assertActive();
        },
      }),
    });
  }
  #publication(context: PluginUiActionContext) {
    const descriptor = context.lease.descriptor,
      contribution = descriptor.contributions.find(
        (item) => item.id === context.lease.contributionId,
      );
    if (
      !this.supports(context) ||
      contribution?.kind !== "module" ||
      contribution.slot !== "main.content" ||
      !descriptor.requires.some(
        (item) =>
          item.service === CREWON_PROJECT_TEXT_RECOVERY_SERVICE &&
          item.apiVersion === CREWON_PROJECT_TEXT_RECOVERY_API_VERSION &&
          (!item.optional ||
            (descriptor.entrypoints.node !== null &&
              descriptor.businessManifestPath !== null)),
      )
    )
      denied();
  }
  async #policy(
    scope: ProjectTextUiIntentScope,
    action: "creativeProject:read" | "creativeProject:write",
  ) {
    const decision = await this.#dependencies.authorization.authorize({
      actor: scope.actor,
      action,
      resource: {
        kind: "creativeProject",
        tenantId: scope.actor.tenantId,
        spaceId: scope.actor.spaceId,
        projectId: scope.projectId,
      },
    });
    try {
      if (uiRecord(decision, ["outcome"]).outcome !== "allow")
        throw new Error("deny");
    } catch {
      throw new ApplicationError(
        "authorization",
        "creative_project_authorization_denied",
      );
    }
  }
  async #ownedProject(scope: ProjectTextUiIntentScope) {
    const owner = creativeOwner(scope.actor),
      value = await this.#dependencies.projects.loadProject({
        owner,
        projectId: scope.projectId,
      });
    if (value === null)
      throw new ApplicationError("notFound", "creative_project_not_found");
    checkedCreativeProject(value, owner, scope.projectId);
  }
  #at() {
    return creativeProjectTimestamp(this.#dependencies.clock.now());
  }
}
function scopeOf(
  context: PluginUiActionContext,
  installation: ProjectTextUiIntentScope["installation"],
  projectId: string,
) {
  return parseProjectTextUiIntentScope({
    actor: context.actor,
    installation,
    contributionId: context.lease.contributionId,
    projectId,
  });
}
function stored(input: unknown, scope: ProjectTextUiIntentScope) {
  try {
    const value = parseProjectTextUiIntent(input);
    assertProjectTextUiIntentScope(value.scope, scope);
    return value;
  } catch (cause) {
    throw new ApplicationError(
      "internal",
      "project_text_recovery_store_invalid",
      { cause },
    );
  }
}
function publicRecord(
  record: ProjectTextUiIntent,
): ProjectTextRecoveryPendingResponse {
  const receipt = record.receipt;
  return parseProjectTextRecoveryActionResponse(
    {
      action: "crewon.project-text-recovery.v1.getPending",
      input: { projectId: record.scope.projectId },
    },
    {
      intent: {
        intentId: record.intentId,
        revision: record.revision,
        phase: record.phase,
        request: { action: record.actionId, input: record.input },
        requestDigest: record.requestDigest,
        confirmed:
          receipt === null
            ? null
            : {
                kind: receipt.kind,
                artifactId: receipt.artifactId,
                artifactRevision: receipt.artifactRevision,
                contentRevision: receipt.contentRevision,
                requestDigest: receipt.requestDigest,
                resultDigest: receipt.resultDigest,
              },
        refusalCode: record.refusalCode,
      },
    },
  ) as ProjectTextRecoveryPendingResponse;
}
function denied(): never {
  throw new ApplicationError(
    "authorization",
    "plugin_project_text_recovery_unavailable",
  );
}
function invalidStore(): never {
  throw new ApplicationError("internal", "project_text_recovery_store_invalid");
}
async function journalOperation<T>(execute: () => Promise<T>): Promise<T> {
  try {
    return await execute();
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    const code =
      error instanceof Error
        ? "code" in error && typeof error.code === "string"
          ? error.code
          : error.message
        : "";
    if (code === "project_text_ui_intent_not_found")
      throw new ApplicationError("notFound", code, { cause: error });
    if (
      [
        "project_text_ui_intent_pending",
        "project_text_ui_intent_unacknowledged",
        "project_text_ui_intent_revision_conflict",
        "project_text_ui_intent_refused",
        "project_text_idempotency_conflict",
      ].includes(code)
    )
      throw new ApplicationError("conflict", code, { cause: error });
    throw new ApplicationError(
      "internal",
      "project_text_recovery_store_unavailable",
      { cause: error },
    );
  }
}
function method<T extends object, K extends keyof T>(input: T, key: K): T[K] {
  if (input === null || typeof input !== "object")
    throw new ApplicationError(
      "internal",
      "plugin_project_text_recovery_config_invalid",
    );
  for (
    let owner: object | null = input, depth = 0;
    owner !== null && depth < 16;
    owner = Object.getPrototypeOf(owner), depth++
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (descriptor === undefined) continue;
    if (
      !Object.hasOwn(descriptor, "value") ||
      typeof descriptor.value !== "function"
    )
      break;
    return descriptor.value.bind(input) as T[K];
  }
  throw new ApplicationError(
    "internal",
    "plugin_project_text_recovery_config_invalid",
  );
}
