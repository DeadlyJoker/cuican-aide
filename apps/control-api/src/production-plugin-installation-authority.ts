import {
  ApplicationError,
  type ActorContext,
  type PluginInstallationAuthorizationAction,
} from "@crewon/application";
import {
  parsePluginProfileScope,
  type PluginProfileScope,
} from "@crewon/domain";
import {
  pluginSecurityActor,
  pluginSecurityInstallationRequest,
  pluginSecurityUiDecision,
} from "./plugin-security-validation.ts";
import type { ProductionPluginInstallationConfiguration } from "./production-plugin-installation-environment.ts";

/** Private epoch protocol. It does not extend the legacy Application allow/deny wire. */
export class ProductionPluginInstallationAuthority {
  readonly #configuration: ProductionPluginInstallationConfiguration;
  readonly #fetch: typeof globalThis.fetch;
  readonly #controllers = new Set<AbortController>();
  readonly #physical = new Set<Promise<unknown>>();
  #closed = false;
  #closing: Promise<void> | null = null;

  constructor(
    configuration: ProductionPluginInstallationConfiguration,
    fetch = globalThis.fetch,
  ) {
    this.#configuration = configuration;
    this.#fetch = fetch;
  }

  async profile(actor: ActorContext): Promise<PluginProfileScope> {
    const current = pluginSecurityActor(actor);
    const scope = parsePluginProfileScope(
      await this.#post(this.#configuration.profileAuthority, {
        actor: current,
      }),
    );
    if (
      scope.tenantId !== current.tenantId ||
      scope.spaceId !== current.spaceId
    )
      denied("plugin_profile_scope_mismatch");
    return scope;
  }

  async epoch(
    input: Readonly<{
      actor: ActorContext;
      scope: PluginProfileScope;
      action: PluginInstallationAuthorizationAction;
      pluginId: string | null;
      packageDigest: string | null;
    }>,
  ): Promise<string> {
    const request = pluginSecurityInstallationRequest({
      actor: input.actor,
      action: input.action,
      resource: {
        kind: "pluginInstallation",
        ...input.scope,
        pluginId: input.pluginId,
        packageDigest: input.packageDigest,
      },
    });
    const result = pluginSecurityUiDecision(
      await this.#post(this.#configuration.policyAuthority, request),
    );
    if (result.outcome !== "allow") denied("plugin_installation_denied");
    return result.authorityEpoch;
  }

  close(): Promise<void> {
    if (this.#closing !== null) return this.#closing;
    this.#closed = true;
    for (const controller of this.#controllers) controller.abort();
    return (this.#closing = Promise.allSettled([...this.#physical]).then(
      () => {},
    ));
  }

  #post(
    authority: Readonly<{ url: string; serviceToken: string }>,
    payload: unknown,
  ): Promise<unknown> {
    if (this.#closed)
      return Promise.reject(new Error("plugin_installation_authority_closed"));
    if (this.#physical.size >= 128)
      return Promise.reject(new Error("plugin_installation_authority_busy"));
    const controller = new AbortController();
    this.#controllers.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const logical = new Promise<never>((_, reject) => {
      const abort = () =>
        reject(new Error("plugin_installation_authority_unavailable"));
      controller.signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(
        () => controller.abort(),
        this.#configuration.timeoutMs,
      );
    });
    const physical = this.#http(authority, payload, controller.signal);
    this.#physical.add(physical);
    void physical
      .finally(() => {
        this.#physical.delete(physical);
        this.#controllers.delete(controller);
        if (timer !== undefined) clearTimeout(timer);
      })
      .catch(() => {});
    return Promise.race([physical, logical]);
  }

  async #http(
    authority: Readonly<{ url: string; serviceToken: string }>,
    payload: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    const response = await this.#fetch(new URL(authority.url), {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      signal,
      headers: {
        "accept": "application/json",
        "content-type": "application/json",
        "authorization": `Bearer ${authority.serviceToken}`,
      },
      body: JSON.stringify(payload),
    });
    const media = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    const length = response.headers.get("content-length");
    if (
      signal.aborted ||
      response.status !== 200 ||
      (media !== "application/json" && media?.endsWith("+json") !== true) ||
      (length !== null &&
        (!/^\d+$/u.test(length) || Number(length) > 16 * 1024))
    ) {
      await response.body?.cancel();
      throw new Error("plugin_installation_authority_response_invalid");
    }
    if (response.body === null)
      throw new Error("plugin_installation_authority_response_invalid");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        total += part.value.byteLength;
        if (signal.aborted || total > 16 * 1024) {
          await reader.cancel();
          throw new Error("plugin_installation_authority_response_invalid");
        }
        chunks.push(part.value);
      }
      signal.throwIfAborted();
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } finally {
      reader.releaseLock();
    }
  }
}

function denied(code: string): never {
  throw new ApplicationError("authorization", code);
}
