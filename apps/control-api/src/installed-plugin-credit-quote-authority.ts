import {
  ApplicationError,
  type ContentDigester,
  type ExtensionCreditQuotePort,
} from "@crewon/application";
import { parsePluginUiJsonValue } from "@crewon/contracts/plugins";
import {
  extensionCanonicalJson,
  extensionDigest,
  parseExtensionRunBinding,
  pluginInstallationOpaqueId,
} from "@crewon/domain";
import {
  pluginSecurityActor,
  pluginSecurityRecord,
} from "./plugin-security-validation.ts";
import type { InstalledPluginTaskEndpoint } from "./installed-plugin-task-environment.ts";

/** Owns bounded authority responses and all physical fetch/body work, including late cancellation. */
export class InstalledPluginTaskHttpAuthority {
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  readonly #lifetime = new AbortController();
  readonly #pending = new Set<Promise<unknown>>();
  #closing: Promise<void> | null = null;
  constructor(
    input: Readonly<{ timeoutMs: number; fetch?: typeof globalThis.fetch }>,
  ) {
    if (
      !Number.isSafeInteger(input.timeoutMs) ||
      input.timeoutMs < 1 ||
      input.timeoutMs > 30_000
    )
      unavailable();
    this.#timeoutMs = input.timeoutMs;
    this.#fetch = input.fetch ?? globalThis.fetch;
  }

  async post(
    endpointInput: InstalledPluginTaskEndpoint,
    input: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (this.#lifetime.signal.aborted || this.#pending.size >= 128)
      unavailable();
    signal.throwIfAborted();
    const endpoint = checkedEndpoint(endpointInput);
    const body = JSON.stringify(parsePluginUiJsonValue(input));
    const deadline = new AbortController();
    const currentSignal = AbortSignal.any([
      signal,
      deadline.signal,
      this.#lifetime.signal,
    ]);
    const timer = setTimeout(() => deadline.abort(), this.#timeoutMs);
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () =>
        reject(
          new ApplicationError(
            "conflict",
            "installed_plugin_task_authority_unavailable",
          ),
        );
      currentSignal.addEventListener("abort", abort, { once: true });
    });
    const physical = Promise.resolve()
      .then(() => this.#send(endpoint, body, currentSignal))
      .finally(() => {
        clearTimeout(timer);
        currentSignal.removeEventListener("abort", abort);
        this.#pending.delete(physical);
      });
    this.#pending.add(physical);
    if (currentSignal.aborted) abort();
    try {
      return await Promise.race([physical, cancelled]);
    } catch {
      throw new ApplicationError(
        "conflict",
        "installed_plugin_task_authority_unavailable",
      );
    }
  }

  close(): Promise<void> {
    this.#lifetime.abort();
    return (this.#closing ??= Promise.allSettled([...this.#pending]).then(
      () => {},
    ));
  }

  async #send(
    endpoint: InstalledPluginTaskEndpoint,
    body: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    signal.throwIfAborted();
    const response = await this.#fetch(endpoint.url, {
      method: "POST",
      cache: "no-store",
      redirect: "error",
      signal,
      headers: {
        "accept": "application/json",
        "authorization": `Bearer ${endpoint.serviceToken}`,
        "content-type": "application/json",
      },
      body,
    });
    const limit = 16 * 1024;
    const length = response.headers.get("content-length");
    if (
      response.status !== 200 ||
      response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase() !== "application/json" ||
      (length !== null &&
        (!/^(0|[1-9][0-9]*)$/u.test(length) || Number(length) > limit)) ||
      response.body === null
    ) {
      await response.body?.cancel().catch(() => {});
      unavailable();
    }
    const reader = response.body.getReader();
    const bytes = new Uint8Array(limit);
    let size = 0,
      chunks = 0,
      complete = false;
    let cancellation: Promise<void> | null = null;
    const cancel = () => {
      cancellation ??= Promise.resolve()
        .then(() => reader.cancel())
        .catch(() => {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    try {
      while (true) {
        signal.throwIfAborted();
        const part = await reader.read();
        if (part.done) {
          complete = true;
          break;
        }
        if (++chunks > 16384 || size + part.value.byteLength > limit)
          unavailable();
        bytes.set(part.value, size);
        size += part.value.byteLength;
      }
      signal.throwIfAborted();
      if (length !== null && Number(length) !== size) unavailable();
      return parsePluginUiJsonValue(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            bytes.subarray(0, size),
          ),
        ),
      );
    } finally {
      if (!complete) cancel();
      await cancellation;
      signal.removeEventListener("abort", cancel);
      reader.releaseLock();
    }
  }
}

/** No amount, pool, payer, grant, or price policy is supplied by this adapter. */
export class InstalledPluginCreditQuoteAuthority
  implements ExtensionCreditQuotePort
{
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
    this.#endpoint = checkedEndpoint(input.endpoint);
    this.#http = input.http;
    this.#digester = Object.freeze({
      sha256: input.digester.sha256.bind(input.digester),
    });
    this.#currentSignal = input.currentSignal.bind(input);
    this.#assertCurrent = input.assertCurrent.bind(input);
  }
  async quoteGeneration(
    input: Parameters<ExtensionCreditQuotePort["quoteGeneration"]>[0],
  ) {
    const value = pluginSecurityRecord(input, [
      "actor",
      "binding",
      "input",
      "commandRequestDigest",
    ]);
    const actor = pluginSecurityActor(value.actor);
    const binding = parseExtensionRunBinding(value.binding, this.#digester);
    if (
      actor.tenantId !== binding.tenantId ||
      actor.spaceId !== binding.spaceId ||
      actor.actorId !== binding.actorId ||
      binding.source !== null
    )
      throw new ApplicationError(
        "authorization",
        "extension_credit_quote_scope_mismatch",
      );
    const body = Object.freeze({
      actor,
      binding,
      input: parsePluginUiJsonValue(value.input),
      commandRequestDigest: extensionDigest(value.commandRequestDigest),
    });
    if (
      this.#digester.sha256(extensionCanonicalJson(body.input)) !==
      binding.inputDigest
    )
      throw new ApplicationError(
        "conflict",
        "extension_credit_quote_input_mismatch",
      );
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

function checkedEndpoint(
  input: InstalledPluginTaskEndpoint,
): InstalledPluginTaskEndpoint {
  const value = pluginSecurityRecord(input, ["url", "serviceToken"]);
  if (
    typeof value.url !== "string" ||
    value.url.length > 2048 ||
    /[\s?#\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value.url) ||
    typeof value.serviceToken !== "string" ||
    value.serviceToken.length < 32 ||
    value.serviceToken.length > 8192 ||
    !/^[\x21-\x7e]+$/u.test(value.serviceToken)
  )
    unavailable();
  const url = new URL(value.url);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    unavailable();
  return Object.freeze({ url: url.href, serviceToken: value.serviceToken });
}
function unavailable(): never {
  throw new ApplicationError(
    "conflict",
    "installed_plugin_task_authority_unavailable",
  );
}
