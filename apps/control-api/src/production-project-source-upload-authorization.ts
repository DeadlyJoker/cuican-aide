import {
  ApplicationError,
  captureSourceUploadPermission,
  type AuthorizationDecision,
  type ProjectSourceUploadAuthorizationPort,
  type ProjectSourceUploadPermission,
} from "@crewon/application";
import { pluginSecurityRecord } from "./plugin-security-validation.ts";

const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_PENDING = 64;
type FetchPort = (url: string, init: RequestInit) => Promise<Response>;

/** Dedicated upload PDP request, with the independently validated original owner and action. */
export type ProductionProjectSourceUploadPolicyRequest =
  ProjectSourceUploadPermission;
export type ProductionProjectSourceUploadAuthorizationConfig = Readonly<{
  url: string;
  serviceToken: string;
  timeoutMs: number;
  fetch?: FetchPort;
}>;

/** A live host policy client. Local lifetime checks never substitute for its business PDP decision. */
export class ProductionProjectSourceUploadAuthorization
  implements ProjectSourceUploadAuthorizationPort
{
  readonly #url: string;
  readonly #serviceToken: string;
  readonly #timeoutMs: number;
  readonly #fetch: FetchPort;
  readonly #pending = new Set<AbortController>();
  #active = true;
  constructor(config: ProductionProjectSourceUploadAuthorizationConfig) {
    let url: URL;
    try {
      if (typeof config.url !== "string" || config.url.length > 2048)
        invalidConfiguration();
      url = new URL(config.url);
    } catch {
      invalidConfiguration();
    }
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== "" ||
      url.search !== "" ||
      typeof config.serviceToken !== "string" ||
      new TextEncoder().encode(config.serviceToken).length < 32 ||
      new TextEncoder().encode(config.serviceToken).length > 8192 ||
      !Number.isSafeInteger(config.timeoutMs) ||
      config.timeoutMs < 1 ||
      config.timeoutMs > 30_000 ||
      (config.fetch !== undefined && typeof config.fetch !== "function")
    )
      invalidConfiguration();
    this.#url = url.href;
    this.#serviceToken = config.serviceToken;
    this.#timeoutMs = config.timeoutMs;
    this.#fetch = config.fetch ?? fetch;
    Object.freeze(this);
  }

  /** Synchronous host withdrawal is visible to the final actual Store commit gate. */
  close(): void {
    this.#active = false;
    for (const controller of this.#pending) controller.abort(unavailable());
  }
  assertActive(permission: ProjectSourceUploadPermission): void {
    this.#assertAlive();
    captureSourceUploadPermission(permission);
  }
  async authorize(
    input: ProjectSourceUploadPermission,
  ): Promise<AuthorizationDecision> {
    this.#assertAlive();
    const request: ProductionProjectSourceUploadPolicyRequest =
      captureSourceUploadPermission(input);
    if (this.#pending.size >= MAX_PENDING) throw unavailable();
    const controller = new AbortController();
    this.#pending.add(controller);
    let rejectAborted: ((reason: unknown) => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      rejectAborted = reject;
    });
    const onAbort = () =>
      rejectAborted?.(controller.signal.reason ?? unavailable());
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () => controller.abort(unavailable()),
      this.#timeoutMs,
    );
    try {
      const physical = Promise.resolve().then(async () => {
        this.assertActive(request);
        controller.signal.throwIfAborted();
        const response = await this.#fetch(this.#url, {
          method: "POST",
          headers: {
            "accept": "application/json",
            "authorization": `Bearer ${this.#serviceToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(request),
          redirect: "error",
          signal: controller.signal,
        });
        const output = await readResponse(response, controller.signal);
        this.assertActive(request);
        controller.signal.throwIfAborted();
        return decision(output);
      });
      // The losing physical promise remains observed; no policy retry or manufactured allow is returned.
      return await Promise.race([physical, cancelled]);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
      rejectAborted = undefined;
      this.#pending.delete(controller);
    }
  }
  #assertAlive(): void {
    if (!this.#active) throw unavailable();
  }
}

async function readResponse(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  const type = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  const length = response.headers.get("content-length");
  if (
    response.status !== 200 ||
    !(type === "application/json" || type?.endsWith("+json")) ||
    (length !== null &&
      (!/^\d+$/u.test(length) || Number(length) > MAX_RESPONSE_BYTES)) ||
    response.body === null
  ) {
    await response.body?.cancel();
    throw unavailable();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const value = await reader.read();
      if (value.done) break;
      bytes += value.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw unavailable();
      }
      chunks.push(value.value);
    }
  } finally {
    reader.releaseLock();
  }
  signal.throwIfAborted();
  const result = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result));
  } catch {
    throw unavailable();
  }
}
function decision(input: unknown): AuthorizationDecision {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw unavailable();
  const fields = Reflect.ownKeys(input);
  const value = pluginSecurityRecord(
    input,
    fields.includes("reasonCode") ? ["outcome", "reasonCode"] : ["outcome"],
  );
  if (value.outcome === "allow" && fields.length === 1)
    return Object.freeze({ outcome: "allow" });
  if (
    value.outcome === "deny" &&
    fields.length === 2 &&
    typeof value.reasonCode === "string" &&
    /^[a-z][a-z0-9_:-]{0,127}$/u.test(value.reasonCode)
  )
    return Object.freeze({ outcome: "deny", reasonCode: value.reasonCode });
  throw unavailable();
}
function invalidConfiguration(): never {
  throw new Error(
    "production_project_source_upload_policy_configuration_invalid",
  );
}
function unavailable(): ApplicationError {
  return new ApplicationError(
    "authorization",
    "production_project_source_upload_policy_unavailable",
  );
}
