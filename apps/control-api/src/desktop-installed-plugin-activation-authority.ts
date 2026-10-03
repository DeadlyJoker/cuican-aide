import {
  ApplicationError,
  type ActorContext,
  type AuthorizationDecision,
} from "@crewon/application";
import { pluginSecurityRecord } from "./plugin-security-validation.ts";
import type { DesktopInstalledPluginActivationConfig } from "./desktop-installed-plugin-activation-environment.ts";

/** Owns each physical policy fetch and body until joined, even after a logical deadline. */
export class DesktopInstalledPluginActivationAuthority {
  readonly #configuration: DesktopInstalledPluginActivationConfig;
  readonly #fetch: typeof globalThis.fetch;
  readonly #lifetime = new AbortController();
  readonly #physical = new Set<Promise<AuthorizationDecision>>();
  #closing: Promise<void> | null = null;
  constructor(
    configuration: DesktopInstalledPluginActivationConfig,
    dependencies: Readonly<{ fetch?: typeof globalThis.fetch }> = {},
  ) {
    this.#configuration = configuration;
    this.#fetch =
      dependencies.fetch?.bind(dependencies) ??
      globalThis.fetch.bind(globalThis);
  }
  decide(
    input: Readonly<{ actor: ActorContext; pluginId: string }>,
    signal: AbortSignal,
  ): Promise<AuthorizationDecision> {
    this.#lifetime.signal.throwIfAborted();
    signal.throwIfAborted();
    if (this.#physical.size >= 128) denied();
    const controller = new AbortController();
    const joined = AbortSignal.any([
      signal,
      controller.signal,
      this.#lifetime.signal,
    ]);
    const timer = setTimeout(
      () => controller.abort(),
      this.#configuration.publication.timeoutMs,
    );
    timer.unref();
    const physical = Promise.resolve()
      .then(() =>
        this.#http(
          {
            actor: input.actor,
            action: "extension:activate",
            resource: {
              kind: "extension",
              tenantId: input.actor.tenantId,
              spaceId: input.actor.spaceId,
              pluginId: input.pluginId,
            },
          },
          joined,
        ),
      )
      .catch(() => denied());
    this.#physical.add(physical);
    void physical
      .finally(() => {
        clearTimeout(timer);
        this.#physical.delete(physical);
      })
      .catch(() => {});
    let abort!: () => void;
    const logical = new Promise<never>((_, reject) => {
      abort = () =>
        reject(
          new ApplicationError(
            "authorization",
            "desktop_plugin_activation_authority_unavailable",
          ),
        );
      joined.addEventListener("abort", abort, { once: true });
      if (joined.aborted) abort();
    });
    return Promise.race([physical, logical]).finally(() =>
      joined.removeEventListener("abort", abort),
    );
  }
  close(): Promise<void> {
    this.#lifetime.abort();
    return (this.#closing ??= Promise.allSettled([...this.#physical]).then(
      () => {},
    ));
  }
  async #http(
    payload: unknown,
    signal: AbortSignal,
  ): Promise<AuthorizationDecision> {
    signal.throwIfAborted();
    const response = await this.#fetch(
      new URL(this.#configuration.publication.authority.url),
      {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        signal,
        headers: {
          "accept": "application/json",
          "content-type": "application/json",
          "authorization": `Bearer ${this.#configuration.authorityToken}`,
        },
        body: JSON.stringify(payload),
      },
    );
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
      denied();
    }
    if (response.body === null) denied();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let complete = false;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) {
          complete = true;
          break;
        }
        total += part.value.byteLength;
        if (signal.aborted || total > 16 * 1024) {
          await reader.cancel();
          denied();
        }
        chunks.push(part.value);
      }
      signal.throwIfAborted();
      const bytes = Buffer.concat(chunks, total);
      const raw = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
      const outcome = Object.getOwnPropertyDescriptor(
        raw ?? {},
        "outcome",
      )?.value;
      const fields = pluginSecurityRecord(
        raw,
        outcome === "allow" ? ["outcome"] : ["outcome", "reasonCode"],
      );
      if (fields.outcome === "allow") return { outcome: "allow" };
      if (
        fields.outcome === "deny" &&
        typeof fields.reasonCode === "string" &&
        /^[a-z][a-z0-9_:-]{0,127}$/u.test(fields.reasonCode)
      )
        return { outcome: "deny", reasonCode: fields.reasonCode };
      denied();
    } catch (error) {
      if (!complete) await reader.cancel();
      throw error;
    } finally {
      reader.releaseLock();
    }
  }
}
function denied(): never {
  throw new ApplicationError(
    "authorization",
    "desktop_plugin_activation_authority_unavailable",
  );
}
