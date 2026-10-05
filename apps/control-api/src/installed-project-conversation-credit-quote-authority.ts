import {
  ApplicationError,
  type ContentDigester,
  type ProjectConversationGenerationCreditQuoteRequest,
} from "@crewon/application";
import { parsePluginUiJsonValue } from "@crewon/contracts/plugins";
import {
  extensionCanonicalJson,
  extensionDigest,
  parseExtensionRunBinding,
  parseProjectStageRunAdmission,
  pluginInstallationOpaqueId,
} from "@crewon/domain";
import { InstalledPluginTaskHttpAuthority } from "./installed-plugin-credit-quote-authority.ts";
import {
  PROJECT_CONVERSATION_CREDIT_QUOTE_VERSION,
  type InstalledPluginTaskEndpoint,
} from "./installed-plugin-task-environment.ts";
import {
  pluginSecurityActor,
  pluginSecurityRecord,
} from "./plugin-security-validation.ts";

/** Explicit qualified quote protocol. The original task quote retains its canonical-JSON contract. */
export class InstalledProjectConversationCreditQuoteAuthority {
  readonly #endpoint: InstalledPluginTaskEndpoint;
  readonly #http: InstalledPluginTaskHttpAuthority;
  readonly #digester: ContentDigester;
  readonly #currentSignal: () => AbortSignal;
  readonly #assertCurrent: () => Promise<void>;
  constructor(
    input: Readonly<{
      endpoint: InstalledPluginTaskEndpoint;
      http: InstalledPluginTaskHttpAuthority;
      digester: ContentDigester;
      currentSignal(): AbortSignal;
      assertCurrent(): Promise<void>;
    }>,
  ) {
    this.#endpoint = Object.freeze({
      ...pluginSecurityRecord(input.endpoint, ["url", "serviceToken"]),
    }) as InstalledPluginTaskEndpoint;
    this.#http = input.http;
    this.#digester = Object.freeze({
      sha256: input.digester.sha256.bind(input.digester),
    });
    this.#currentSignal = input.currentSignal.bind(input);
    this.#assertCurrent = input.assertCurrent.bind(input);
  }
  async quoteProjectConversationGeneration(
    input: ProjectConversationGenerationCreditQuoteRequest,
  ) {
    const v = pluginSecurityRecord(input, [
      "actor",
      "binding",
      "input",
      "commandRequestDigest",
      "projectStageAdmission",
    ]);
    const actor = pluginSecurityActor(v.actor),
      binding = parseExtensionRunBinding(v.binding, this.#digester),
      stage = parseProjectStageRunAdmission(
        v.projectStageAdmission,
        this.#digester,
      );
    const payload = pluginSecurityRecord(v.input, ["prompt"]);
    const commandRequestDigest = extensionDigest(v.commandRequestDigest);
    if (
      binding.source !== null ||
      extensionCanonicalJson(actor) !== extensionCanonicalJson(stage.actor) ||
      actor.tenantId !== binding.tenantId ||
      actor.spaceId !== binding.spaceId ||
      actor.actorId !== binding.actorId ||
      stage.runId !== binding.runId ||
      stage.threadId !== binding.threadId ||
      stage.installation.tenantId !== binding.tenantId ||
      stage.installation.spaceId !== binding.spaceId ||
      stage.installation.pluginId !== binding.pluginId ||
      stage.extensionBindingDigest !== binding.bindingDigest ||
      stage.requestDigest !== commandRequestDigest
    )
      throw new ApplicationError(
        "authorization",
        "extension_credit_quote_scope_mismatch",
      );
    if (
      typeof payload.prompt !== "string" ||
      this.#digester.sha256(payload.prompt) !== binding.inputDigest ||
      stage.userContentDigest !== binding.inputDigest
    )
      throw new ApplicationError(
        "conflict",
        "extension_credit_quote_input_mismatch",
      );
    const body = Object.freeze({
      schemaVersion: PROJECT_CONVERSATION_CREDIT_QUOTE_VERSION,
      actor,
      binding,
      input: parsePluginUiJsonValue(payload),
      commandRequestDigest,
      projectStageAdmission: stage,
    });
    await this.#assertCurrent();
    const response = pluginSecurityRecord(
      await this.#http.post(this.#endpoint, body, this.#currentSignal()),
      ["poolId", "priceRevision", "quotedCredits"],
    );
    await this.#assertCurrent();
    if (
      !Number.isSafeInteger(response.priceRevision) ||
      (response.priceRevision as number) < 1 ||
      typeof response.quotedCredits !== "string" ||
      !/^[1-9][0-9]{0,47}$/u.test(response.quotedCredits)
    )
      throw new ApplicationError("conflict", "extension_credit_quote_invalid");
    return Object.freeze({
      poolId: pluginInstallationOpaqueId(response.poolId),
      priceRevision: response.priceRevision as number,
      quotedCredits: response.quotedCredits,
    });
  }
}
