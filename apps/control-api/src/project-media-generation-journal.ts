import { createHash } from "node:crypto";
import {
  createPluginUiIntentPayloadVerifier,
  type CreativeProjectCommitAuthority,
  type PluginUiIntentJournalStore,
} from "@crewon/application";
import {
  extensionCanonicalJson,
  parsePluginUiIntentJournalAccount,
  parsePluginUiIntentRecord,
  pluginUiIntentStablePin,
  pluginUiIntentIdentity,
  PLUGIN_UI_MEDIA_NOT_ADMITTED,
  type PluginTaskAdmissionPin,
} from "@crewon/domain";
import {
  PROJECT_MEDIA_GENERATE_UI_ACTION,
  parseGenerateProjectMediaResponse,
  parseProjectMediaGenerationUiRequest,
  type GenerateProjectMediaRequest,
  type GenerateProjectMediaResponse,
} from "@crewon/contracts/project-media-generations";
import { parseProjectMediaGenerationRecoveryResponse } from "@crewon/contracts/project-media-generation-recovery";
import {
  installedProjectMediaGenerationTaskAuthority,
  type InstalledPluginTaskRuntimeCore,
} from "./installed-plugin-task-runtime-core.ts";

const digester = Object.freeze({
  sha256: (text: string) =>
    "sha256:" + createHash("sha256").update(text).digest("hex"),
});
export type ProjectMediaGenerationDispatch = Readonly<{
  confirm(receipt: GenerateProjectMediaResponse): Promise<void>;
  refuseBeforeAdmission(): Promise<void>;
}>;

/** HTTP shares the parent's existing journal with the plugin page. No UI lease, executor or database is created. */
export class ProjectMediaGenerationJournal {
  readonly #store: PluginUiIntentJournalStore;
  private constructor(store: PluginUiIntentJournalStore) {
    this.#store = store;
  }
  static async prepare(core: InstalledPluginTaskRuntimeCore) {
    const host = installedProjectMediaGenerationTaskAuthority(core);
    const store = host.store.pluginUiIntentJournalStore({
      verifier: createPluginUiIntentPayloadVerifier(digester),
    });
    await store.migratePluginUiIntentJournal();
    host.assertActive();
    return new ProjectMediaGenerationJournal(store);
  }
  #account(pin: PluginTaskAdmissionPin) {
    return parsePluginUiIntentJournalAccount({
      controlRealmId: this.#store.uiIntentJournalRealmId,
      tenantId: pin.tenantId,
      spaceId: pin.spaceId,
      principalId: pin.principalId,
    });
  }
  async begin(
    command: GenerateProjectMediaRequest,
    authority: CreativeProjectCommitAuthority,
  ): Promise<ProjectMediaGenerationDispatch> {
    const sourcePin = authority.transaction?.pin;
    if (!sourcePin || sourcePin.action !== PROJECT_MEDIA_GENERATE_UI_ACTION)
      throw new Error("project_media_generation_journal_authority_required");
    const account = this.#account(sourcePin);
    const request = parseProjectMediaGenerationUiRequest({
      action: PROJECT_MEDIA_GENERATE_UI_ACTION,
      input: command,
    });
    const requestJson = extensionCanonicalJson(request);
    await authority.assertCurrent();
    const staged = await this.#store.stageUiIntent(
      { account, sourcePin, requestJson, at: new Date().toISOString() },
      { authority },
    );
    await authority.assertCurrent();
    await this.#store.markUiIntentDispatched(
      {
        account,
        intentId: staged.intent.intentId,
        sourcePin,
        requestJson,
        at: new Date().toISOString(),
      },
      { authority },
    );
    await authority.assertCurrent();
    return this.observe(command, sourcePin);
  }
  /** Used only by the genuine runtime after the original UI wrapper has marked this exact dispatch. */
  observe(
    command: GenerateProjectMediaRequest,
    sourcePin: PluginTaskAdmissionPin,
  ): ProjectMediaGenerationDispatch {
    const account = this.#account(sourcePin);
    const request = parseProjectMediaGenerationUiRequest({
      action: PROJECT_MEDIA_GENERATE_UI_ACTION,
      input: command,
    });
    const intentId = pluginUiIntentIdentity(
      account,
      sourcePin,
      command.idempotencyKey,
      digester,
    );
    const requestDigest = digester.sha256(extensionCanonicalJson(request));
    return Object.freeze({
      refuseBeforeAdmission: async () => {
        // Trusted command owner proved no TaskCore call. Store CAS preserves all
        // earlier unknown or concurrent dispatches (count > 1), and accepted Runs.
        await this.#store.refuseUiIntentFirstDispatch({
          account,
          intentId,
          requestDigest,
          expectedDispatchAttemptCount: 1,
          reasonCode: PLUGIN_UI_MEDIA_NOT_ADMITTED,
          at: new Date().toISOString(),
        });
      },
      confirm: async (result: GenerateProjectMediaResponse) => {
        // Original TaskCore already committed. Late withdrawal must not erase its receipt.
        const receipt = parseGenerateProjectMediaResponse(command, result);
        try {
          await this.#store.confirmUiIntentAccepted({
            account,
            intentId,
            requestDigest,
            receiptJson: extensionCanonicalJson(receipt),
            at: new Date().toISOString(),
          });
        } catch {
          // The durable TaskCore receipt still wins; recovery retries the exact original command.
          process.emitWarning(
            "project_media_generation_journal_confirmation_failed",
          );
        }
      },
    });
  }
  async recover(authority: CreativeProjectCommitAuthority) {
    const current = authority.transaction?.pin;
    if (!current || current.action !== PROJECT_MEDIA_GENERATE_UI_ACTION)
      throw new Error("project_media_generation_journal_authority_required");
    const account = this.#account(current);
    await authority.assertCurrent();
    const records = await this.#store.listUiIntentHints({ account });
    await authority.assertCurrent();
    if (records.length > 32)
      throw new Error("project_media_generation_journal_invalid");
    const family = records
      .map((raw) => {
        const record = parsePluginUiIntentRecord(raw, digester);
        if (
          extensionCanonicalJson(record.account) !==
          extensionCanonicalJson(account)
        )
          throw new Error("project_media_generation_journal_invalid");
        return record;
      })
      .filter(
        (r) =>
          r.sourcePin.pluginId === current.pluginId &&
          r.sourcePin.contributionId === current.contributionId &&
          r.sourcePin.action === PROJECT_MEDIA_GENERATE_UI_ACTION,
      )
      .sort((a, b) => b.sequence - a.sequence);
    const record =
      family.find((r) => r.phase === "prepared" || r.phase === "dispatched") ??
      family[0];
    if (!record)
      return parseProjectMediaGenerationRecoveryResponse({ intent: null });
    const request = parseProjectMediaGenerationUiRequest(
      JSON.parse(record.requestJson),
    );
    const unresolved =
      record.phase === "prepared" || record.phase === "dispatched";
    const matched =
      pluginUiIntentStablePin(record.sourcePin) ===
        pluginUiIntentStablePin(current) &&
      record.sourcePin.selectionRevision === current.selectionRevision;
    const {
      pluginId,
      publisherId,
      version,
      packageDigest,
      selectionRevision,
      contributionId,
    } = record.sourcePin;
    return parseProjectMediaGenerationRecoveryResponse({
      intent: {
        sourcePin: {
          pluginId,
          publisherId,
          version,
          packageDigest,
          selectionRevision,
          contributionId,
        },
        request,
        revision: record.revision,
        phase: record.phase,
        dispatchMayHaveOccurred: record.dispatchMayHaveOccurred,
        dispatchAttemptCount: record.dispatchAttemptCount,
        receipt:
          record.receiptJson === null
            ? null
            : parseGenerateProjectMediaResponse(
                request.input,
                JSON.parse(record.receiptJson),
              ),
        retryable: unresolved && matched,
        reasonCode:
          record.phase === "accepted"
            ? null
            : (record.reasonCode ??
              (unresolved && !matched
                ? "plugin_ui_recovery_source_changed"
                : null)),
      },
    });
  }
}
