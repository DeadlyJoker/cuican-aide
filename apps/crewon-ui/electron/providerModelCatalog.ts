/**
 * Model-list discovery for the provider settings form.
 *
 * A provider is not one model: the form asks the provider itself which models
 * it advertises. The staged `provider-model-catalog.mjs` runtime performs the
 * bounded OpenAI-compatible `/models` probe (egress policy, secret-leak checks,
 * non-agent filtering); this module validates the form request, resolves the
 * credential to use (typed key, stored keychain secret, or environment
 * variable), and runs that probe as a short-lived child process.
 */

import { spawn } from "node:child_process";

import type { ProviderCredentialStore } from "./providerCredentials.ts";
import { nodeArguments, type RuntimePaths } from "./runtimeSupervisor.ts";
import { processRuntimeLogs } from "./processRuntimeLogs.ts";
import { desktopPluginCreditSettlementSharedEnvironment } from "./desktopPluginCreditSettlementEnvironment.ts";

const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_MODELS = 32;
const DEADLINE_MS = 10_000;
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const ENVIRONMENT_VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const PROBE_STATUSES = new Set([
  "ok",
  "credentialMissing",
  "authenticationFailed",
  "rateLimited",
  "providerError",
  "unreachable",
  "invalidResponse",
  "bindingMismatch",
]);
/** Stand-in default model when the form field is still empty; stripped again. */
const SENTINEL_MODEL_ID = "__crewon_form_default__";

export type ProviderModelCatalogOutcome = Readonly<{
  models: readonly string[];
  status: string;
}>;

type CatalogRequest = Readonly<{
  apiKey: string | null;
  defaultModelId: string | null;
  endpoint: string;
  environmentVariable: string | null;
  providerId: string;
}>;

/** Resolves the models a form draft's endpoint advertises, plus probe status. */
export async function providerModelCatalogForForm(
  value: unknown,
  options: {
    providers: ProviderCredentialStore;
    paths: RuntimePaths;
  },
): Promise<ProviderModelCatalogOutcome> {
  const request = parseRequest(value);
  const saved =
    request.apiKey === null && request.environmentVariable === null
      ? options.providers
          .catalog()
          .bindings.find((binding) => binding.providerId === request.providerId)
      : undefined;
  const canReuseStoredKey =
    saved !== undefined &&
    new URL(saved.endpoint).href.replace(/\/+$/u, "") ===
      new URL(request.endpoint).href.replace(/\/+$/u, "");
  const secret =
    request.apiKey ??
    (request.environmentVariable !== null || canReuseStoredKey
      ? options.providers.secretFor(
          request.providerId,
          request.environmentVariable,
        )
      : null);
  const result = await runCatalogProbe(options.paths, {
    apiKey: secret,
    defaultModelId: request.defaultModelId ?? SENTINEL_MODEL_ID,
    endpoint: request.endpoint,
    providerId: request.providerId,
  });
  return {
    models: result.models.filter((id) => id !== SENTINEL_MODEL_ID),
    status: result.status,
  };
}

function parseRequest(value: unknown): CatalogRequest {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !==
      [
        "apiKey",
        "defaultModelId",
        "endpoint",
        "environmentVariable",
        "providerId",
      ]
        .sort()
        .join("\0")
  ) {
    throw new Error("provider_model_catalog_request_invalid");
  }
  const input = value as Record<string, unknown>;
  return {
    apiKey: optionalBounded(input.apiKey, 32 * 1024),
    defaultModelId: optionalBounded(input.defaultModelId, 256),
    endpoint: parseEndpoint(input.endpoint),
    environmentVariable:
      input.environmentVariable === null
        ? null
        : parseEnvironmentVariable(input.environmentVariable),
    providerId: parseProviderId(input.providerId),
  };
}

function parseProviderId(value: unknown): string {
  if (typeof value !== "string" || !PROVIDER_ID_PATTERN.test(value)) {
    throw new Error("provider_model_catalog_request_invalid");
  }
  return value;
}

function parseEndpoint(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048) {
    throw new Error("provider_model_catalog_request_invalid");
  }
  const url = new URL(value);
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/u.test(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("provider_model_catalog_request_invalid");
  }
  return value;
}

function parseEnvironmentVariable(value: unknown): string {
  if (typeof value !== "string" || !ENVIRONMENT_VARIABLE_PATTERN.test(value)) {
    throw new Error("provider_model_catalog_request_invalid");
  }
  return value;
}

function optionalBounded(value: unknown, maximum: number): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value) > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("provider_model_catalog_request_invalid");
  }
  return value;
}

function runCatalogProbe(
  paths: RuntimePaths,
  input: Readonly<{
    apiKey: string | null;
    defaultModelId: string;
    endpoint: string;
    providerId: string;
  }>,
): Promise<ProviderModelCatalogOutcome> {
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const child = spawn(
      process.execPath,
      nodeArguments(paths.modelCatalog, paths.source),
      {
        env: desktopPluginCreditSettlementSharedEnvironment({
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
        }),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
      settle();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error("provider_model_catalog_timeout"))),
      DEADLINE_MS,
    );
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
      if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) {
        finish(() => reject(new Error("provider_model_catalog_failed")));
      }
    });
    child.stderr?.on("data", (chunk: Buffer) =>
      processRuntimeLogs().write("stderr", "Model catalog", chunk),
    );
    child.once("error", () =>
      finish(() => reject(new Error("provider_model_catalog_failed"))),
    );
    child.once("close", (code) => {
      if (settled) return;
      let outcome: ProviderModelCatalogOutcome;
      try {
        if (code !== 0) throw new Error("provider_model_catalog_failed");
        outcome = parseOutput(output);
      } catch (error) {
        finish(() =>
          reject(
            error instanceof Error
              ? error
              : new Error("provider_model_catalog_failed"),
          ),
        );
        return;
      }
      finish(() => resolve(outcome));
    });
    child.stdin?.once("error", () =>
      finish(() => reject(new Error("provider_model_catalog_failed"))),
    );
    child.stdin?.end(`${JSON.stringify(input)}\n`);
  });
}

function parseOutput(output: string): ProviderModelCatalogOutcome {
  const line = output.trim().split("\n")[0] ?? "";
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("provider_model_catalog_failed");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== "models\0status"
  ) {
    throw new Error("provider_model_catalog_failed");
  }
  const record = value as { models: unknown; status: unknown };
  if (
    !Array.isArray(record.models) ||
    record.models.length > MAX_MODELS ||
    !record.models.every((id) => optionalBounded(id, 256) !== null) ||
    typeof record.status !== "string" ||
    !PROBE_STATUSES.has(record.status)
  ) {
    throw new Error("provider_model_catalog_failed");
  }
  return { models: record.models as readonly string[], status: record.status };
}
