import { parsePluginPackageDescriptor } from "@crewon/contracts/plugins";
import { PROJECT_TEXT_RECOVERY_METHOD_ACTIONS } from "@crewon/contracts/project-text-recovery";
import {
  PROJECT_TEXT_UI_METHOD_ACTIONS,
  type ProjectTextUiMethod,
} from "@crewon/contracts/project-texts-ui";
import {
  extensionCanonicalJson,
  parseProjectTextUiIntent,
  assertProjectTextUiIntentScope,
  type ProjectTextUiIntent,
} from "@crewon/domain";
import { PluginProjectTextActionOwner } from "./plugin-project-text-action-owner.ts";
import { PluginProjectTextRecoveryActionOwner } from "./plugin-project-text-recovery-action-owner.ts";
import { PluginProjectTextRecoveryApplicationService } from "./plugin-project-text-recovery-application-service.ts";
import { PluginUiApplicationService } from "./plugin-ui-application-service.ts";
import { projectTextActionFixture } from "./plugin-project-text-action.test-support.ts";
import { sha256 } from "./project-text.test-support.ts";
import {
  uiTestActor,
  uiTestBytes,
  uiTestMountCommand,
} from "./plugin-ui.test-support.ts";
import { captureCreativeProjectCommitAuthority } from "./creative-project-commit-authority.ts";
import { captureProjectTextRecoveryCommitAuthority } from "./project-text-recovery-commit-authority.ts";
import { projectTextUiMutationCommand } from "./project-text-ui-commit-authority.ts";
import type { ProjectTextUiIntentJournalStore } from "./project-text-ui-intent-journal-store-port.ts";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";
import type { ProjectTextMutationResult } from "./project-text-store-port.ts";

/** Named memory ports test actual Application/mount authority. SQL atomicity is covered by real Store/HTTP suites. */
export async function projectTextRecoveryFixture() {
  const f = await projectTextActionFixture();
  await f.owner.close();
  f.ui.state.descriptor = parsePluginPackageDescriptor({
    ...f.ui.state.descriptor,
    requires: [
      ...f.ui.state.descriptor.requires,
      {
        service: "crewon.project-text-recovery",
        apiVersion: "1",
        optional: false,
      },
    ],
  });
  const state = {
    record: null as ProjectTextUiIntent | null,
    stageCalls: 0,
    ackCalls: 0,
    reads: 0,
    refusals: 0,
    contexts: [] as PluginUiActionContext[],
    beforeRead: null as (() => Promise<void>) | null,
    afterAck: null as (() => void) | null,
    dropReply: false,
    denyWrite: false,
  };
  const finish = (result: ProjectTextMutationResult) => {
    const record = state.record;
    if (record === null || record.phase !== "pending") return;
    state.record = parseProjectTextUiIntent({
      ...record,
      revision: record.revision + 1,
      phase: "accepted",
      receipt: {
        kind: result.kind,
        idempotencyKey: record.input.idempotencyKey,
        requestDigest: record.requestDigest,
        resultDigest: sha256(extensionCanonicalJson(result)),
        artifactId: result.artifact.artifactId,
        artifactRevision: result.artifact.revision,
        contentRevision: result.contentRevision?.contentRevision ?? null,
      },
      updatedAt: f.ui.state.now,
    });
  };
  f.store.afterCommit = () => finish(f.store.commits.at(-1)!);
  const journal: ProjectTextUiIntentJournalStore = {
    migrate: async () => undefined,
    stage: async (input, options) => {
      state.stageCalls++;
      const authority = captureCreativeProjectCommitAuthority(options, {
        allowTextUiTransaction: true,
      })!;
      const tx = authority.textUiTransaction!;
      if (tx.intentRef === undefined)
        throw new Error("missing genuine intent reference");
      await authority.assertCurrent();
      authority.assertActive();
      const previous = state.record;
      if (
        previous !== null &&
        extensionCanonicalJson(previous.scope) ===
          extensionCanonicalJson(input.scope)
      ) {
        if (
          previous.input.idempotencyKey ===
          (input.input as Record<string, unknown>).idempotencyKey
        ) {
          if (
            extensionCanonicalJson(previous.input) !==
            extensionCanonicalJson(input.input)
          )
            throw new Error("project_text_idempotency_conflict");
          return previous;
        }
        if (previous.acknowledgedAt === null)
          throw new Error("project_text_ui_intent_pending");
      }
      const receipt = projectTextUiMutationCommand(tx, { sha256 }).receipt;
      state.record = parseProjectTextUiIntent({
        schemaVersion: "crewon.project-text-ui-intent.v1",
        scope: input.scope,
        intentId: input.intentId,
        revision: 1,
        phase: "pending",
        actionId: input.actionId,
        input: input.input,
        requestDigest: receipt.requestDigest,
        createdAt: input.at,
        updatedAt: input.at,
        acknowledgedAt: null,
        receipt: null,
        refusalCode: null,
      });
      return state.record;
    },
    getPending: async (input, options) => {
      state.reads++;
      const authority = captureProjectTextRecoveryCommitAuthority(
        options.authority,
      );
      await authority.assertCurrent();
      await state.beforeRead?.();
      authority.assertActive();
      const record = state.record;
      if (
        record === null ||
        record.acknowledgedAt !== null ||
        extensionCanonicalJson(record.scope) !==
          extensionCanonicalJson(input.scope)
      )
        return null;
      return record;
    },
    acknowledge: async (input, options) => {
      state.ackCalls++;
      const authority = captureProjectTextRecoveryCommitAuthority(
        options.authority,
      );
      await authority.assertCurrent();
      authority.assertActive();
      const record = state.record;
      if (record === null)
        throw new Error("project_text_ui_intent_revision_conflict");
      assertProjectTextUiIntentScope(record.scope, input.scope);
      if (record.intentId !== input.intentId)
        throw new Error("project_text_ui_intent_revision_conflict");
      if (record.phase === "pending")
        throw new Error("project_text_ui_intent_pending");
      if (record.acknowledgedAt !== null) {
        if (record.revision !== input.expectedRevision + 1)
          throw new Error("project_text_ui_intent_revision_conflict");
        return { intent: record, disposition: "replayed" };
      }
      if (record.revision !== input.expectedRevision)
        throw new Error("project_text_ui_intent_revision_conflict");
      state.record = parseProjectTextUiIntent({
        ...record,
        revision: record.revision + 1,
        acknowledgedAt: input.at,
        updatedAt: input.at,
      });
      state.afterAck?.();
      return { intent: state.record, disposition: "acknowledged" };
    },
    observeRejected: async (input, options) => {
      state.refusals++;
      const authority = captureCreativeProjectCommitAuthority(options, {
        allowTextUiTransaction: true,
      })!;
      await authority.assertCurrent();
      authority.assertActive();
      const record = state.record!;
      if (record.phase !== "pending") return record;
      state.record = parseProjectTextUiIntent({
        ...record,
        revision: record.revision + 1,
        phase: "refused",
        refusalCode: input.code,
        updatedAt: input.at,
      });
      return state.record;
    },
  };
  const createOwners = (publications = f.publications) => {
    const recovery = new PluginProjectTextRecoveryApplicationService({
      journal,
      projects: f.projects.store,
      publications,
      authorization: {
        authorize: async ({ action }) =>
          f.state.projectAllowed &&
          !(state.denyWrite && action === "creativeProject:write")
            ? { outcome: "allow" }
            : { outcome: "deny", reasonCode: "fixture_project_denied" },
      },
      clock: { now: () => f.ui.state.now },
      ids: { nextId: () => "unused-stable-identity" },
      digester: { sha256 },
    });
    const textOwner = new PluginProjectTextActionOwner({
      texts: f.texts,
      publications: f.publications,
      recovery,
      authorization: {
        authorize: async () => {
          if (!f.state.hostAllowed) throw new Error("host denied");
        },
      },
    });
    const recoveryOwner = new PluginProjectTextRecoveryActionOwner({
      recovery,
      publications,
      authorization: {
        authorize: async () => {
          if (!f.state.hostAllowed) throw new Error("host denied");
        },
      },
    });
    const metadata = {
      isOutcome: (value: unknown) =>
        textOwner.committedMetadata.isOutcome(value) ||
        recoveryOwner.committedMetadata.isOutcome(value),
      verify: (context: PluginUiActionContext, value: never) =>
        textOwner.committedMetadata.isOutcome(value)
          ? textOwner.committedMetadata.verify(context, value)
          : recoveryOwner.committedMetadata.verify(context, value),
    };
    const service = new PluginUiApplicationService({
      store: f.ui.store,
      profiles: { resolve: async () => f.ui.state.scope },
      authorization: {
        authorize: async (input) =>
          f.ui.state.allowed.has(input.action)
            ? { outcome: "allow", authorityEpoch: f.ui.state.epoch }
            : { outcome: "deny", reasonCode: "fixture_ui_denied" },
      },
      packages: {
        verify: async () => ({
          descriptor: f.ui.state.descriptor,
          publicAssets: ["ui.mjs"],
        }),
        readAsset: async () => ({
          bytes: uiTestBytes,
          contentType: "text/javascript; charset=utf-8",
        }),
      },
      ids: { nextId: () => "r".repeat(40) },
      clock: { now: () => f.ui.state.now },
      committedMetadata: metadata,
      actions: {
        invoke: async (context) => {
          state.contexts.push(context);
          const value = await (
            recoveryOwner.supportsAction(context.action)
              ? recoveryOwner
              : textOwner
          ).actions.invoke(context);
          if (state.dropReply)
            throw new Error("named fixture dropped confirmed reply");
          return value;
        },
      },
    });
    return { recovery, textOwner, recoveryOwner, service };
  };
  const owners = createOwners(),
    lease = await owners.service.openMount(uiTestActor, uiTestMountCommand);
  const invoke = (method: ProjectTextUiMethod, input: unknown) =>
    owners.service.invoke(uiTestActor, {
      mountRef: lease.mountRef,
      action: PROJECT_TEXT_UI_METHOD_ACTIONS[method],
      input: input as never,
    });
  const recover = (
    method: keyof typeof PROJECT_TEXT_RECOVERY_METHOD_ACTIONS,
    input: unknown,
  ) =>
    owners.service.invoke(uiTestActor, {
      mountRef: lease.mountRef,
      action: PROJECT_TEXT_RECOVERY_METHOD_ACTIONS[method],
      input: input as never,
    });
  return {
    ...f,
    ...owners,
    textState: f.state,
    state,
    journal,
    lease,
    invoke,
    recover,
    createOwners,
    finish,
    close: async () => {
      await Promise.all([
        owners.textOwner.close(),
        owners.recoveryOwner.close(),
      ]);
    },
  };
}
