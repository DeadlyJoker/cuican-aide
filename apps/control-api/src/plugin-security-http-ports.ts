import type {
  PluginProfileAuthorityPort,
  PluginUiPolicyDecisionPort,
} from "./plugin-security-adapters.ts";
import {
  pluginSecurityActor,
  pluginSecurityRecord,
  pluginSecurityUiRequest,
} from "./plugin-security-validation.ts";

type FetchPort = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
type AuthorityConfig = Readonly<{
  url: string;
  serviceToken: string;
  fetch?: FetchPort;
}>;
const MAX_RESPONSE_BYTES = 16 * 1024;

export class HttpPluginUiPolicyDecisionPort
  implements PluginUiPolicyDecisionPort
{
  readonly #http: PluginSecurityHttpAuthority;

  constructor(config: AuthorityConfig) {
    this.#http = new PluginSecurityHttpAuthority(config);
  }

  async decide(
    input: Parameters<PluginUiPolicyDecisionPort["decide"]>[0],
  ): Promise<unknown> {
    const value = pluginSecurityRecord(input, [
      "actor",
      "action",
      "resource",
      "signal",
    ]);
    const request = pluginSecurityUiRequest({
      actor: value.actor,
      resource: value.resource,
      action: uiAction(value.action),
    });
    return this.#http.post(
      { ...request, action: value.action },
      authoritySignal(value.signal),
      "plugin_ui_policy_authority_unavailable",
    );
  }
}

export class HttpPluginProfileAuthorityPort
  implements PluginProfileAuthorityPort
{
  readonly #http: PluginSecurityHttpAuthority;

  constructor(config: AuthorityConfig) {
    this.#http = new PluginSecurityHttpAuthority(config);
  }

  async resolve(
    input: Parameters<PluginProfileAuthorityPort["resolve"]>[0],
  ): Promise<unknown> {
    const value = pluginSecurityRecord(input, ["actor", "signal"]);
    return this.#http.post(
      { actor: pluginSecurityActor(value.actor) },
      authoritySignal(value.signal),
      "plugin_profile_authority_unavailable",
    );
  }
}

/** Bounded HTTPS transport; caller adapters still validate the authority-specific response schema. */
class PluginSecurityHttpAuthority {
  readonly #url: URL;
  readonly #serviceToken: string;
  readonly #fetch: FetchPort;

  constructor(config: AuthorityConfig) {
    if (
      typeof config.url !== "string" ||
      config.url.length === 0 ||
      config.url.length > 2048
    )
      throw new Error("plugin_security_authority_url_invalid");
    const url = new URL(config.url);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("plugin_security_authority_url_invalid");
    if (
      typeof config.serviceToken !== "string" ||
      Buffer.byteLength(config.serviceToken) < 32 ||
      Buffer.byteLength(config.serviceToken) > 8192 ||
      !/^[\x21-\x7e]+$/u.test(config.serviceToken)
    )
      throw new Error("plugin_security_authority_token_invalid");
    if (config.fetch !== undefined && typeof config.fetch !== "function")
      throw new Error("plugin_security_authority_fetch_invalid");
    this.#url = url;
    this.#serviceToken = config.serviceToken;
    this.#fetch = config.fetch ?? globalThis.fetch;
  }

  async post(
    body: unknown,
    signal: AbortSignal,
    code: string,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(new URL(this.#url), {
        method: "POST",
        cache: "no-store",
        headers: {
          "accept": "application/json",
          "authorization": `Bearer ${this.#serviceToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal,
      });
    } catch (cause) {
      throw new Error(code, { cause });
    }
    const mediaType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    const length = response.headers.get("content-length");
    if (
      response.status !== 200 ||
      (mediaType !== "application/json" &&
        mediaType?.endsWith("+json") !== true) ||
      (length !== null &&
        (!/^\d+$/u.test(length) || Number(length) > MAX_RESPONSE_BYTES))
    ) {
      await response.body?.cancel();
      throw new Error(code);
    }
    if (response.body === null) throw new Error(code);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        total += result.value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error(code);
        }
        chunks.push(result.value);
      }
    } catch (cause) {
      throw new Error(code, { cause });
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch (cause) {
      throw new Error(code, { cause });
    }
  }
}

function authoritySignal(input: unknown): AbortSignal {
  if (!(input instanceof AbortSignal))
    throw new Error("plugin_security_signal_invalid");
  return input;
}

function uiAction(input: unknown): "catalog" | "mount" | "asset" | "invoke" {
  switch (input) {
    case "pluginUi:catalog":
      return "catalog";
    case "pluginUi:mount":
      return "mount";
    case "pluginUi:asset":
      return "asset";
    case "pluginUi:invoke":
      return "invoke";
    default:
      throw new Error("plugin_ui_policy_action_invalid");
  }
}
