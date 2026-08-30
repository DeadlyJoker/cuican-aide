import { createInterface } from "node:readline";

import type { ModelProviderProbeResult } from "@crewon/application";

import { ResponsesProviderConnectivityProbe } from "./provider-connectivity-probe.ts";
import {
  DesktopModelCatalogEgressPolicy,
  ProviderProbeEgressResolver,
} from "./provider-probe-egress.ts";
import { runtimeModelCatalog } from "./runtime-model-catalog.ts";

const MAX_INPUT_BYTES = 40 * 1024;

type ProviderModelCatalogInput = Readonly<{
  apiKey: string | null;
  defaultModelId: string;
  endpoint: string;
  providerId: string;
}>;

type Probe = Readonly<{
  probe(signal: AbortSignal): Promise<ModelProviderProbeResult>;
}>;

export async function providerModelCatalog(
  input: unknown,
  createProbe: (input: ProviderModelCatalogInput) => Probe = modelProbe,
): Promise<Readonly<{ models: readonly string[] }>> {
  const parsed = parseInput(input);
  const result = await createProbe(parsed).probe(new AbortController().signal);
  const advertised =
    result.status === "ok" && result.models !== null
      ? result.models.map(({ id }) => id)
      : [];
  return {
    models: runtimeModelCatalog(
      JSON.stringify(advertised),
      parsed.defaultModelId,
    ),
  };
}

function modelProbe(input: ProviderModelCatalogInput): Probe {
  return new ResponsesProviderConnectivityProbe(
    {
      tenantId: "standalone-tenant",
      providerId: input.providerId,
      catalogRevision: 1,
      runtimeBindingId: "desktop-model-catalog",
      endpoint: input.endpoint,
      secret: input.apiKey,
      deadlineMs: 3_000,
    },
    {
      egress: new ProviderProbeEgressResolver({
        policy: new DesktopModelCatalogEgressPolicy(),
      }),
    },
  );
}

function parseInput(value: unknown): ProviderModelCatalogInput {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !==
      ["apiKey", "defaultModelId", "endpoint", "providerId"].sort().join("\0")
  ) {
    throw new Error("provider_model_catalog_input_invalid");
  }
  const input = value as Record<string, unknown>;
  const endpoint = bounded(input.endpoint, 2_048);
  const parsedEndpoint = new URL(endpoint);
  if (
    (parsedEndpoint.protocol !== "https:" &&
      parsedEndpoint.protocol !== "http:") ||
    parsedEndpoint.username ||
    parsedEndpoint.password ||
    parsedEndpoint.search ||
    parsedEndpoint.hash
  ) {
    throw new Error("provider_model_catalog_input_invalid");
  }
  const apiKey =
    input.apiKey === null ? null : bounded(input.apiKey, 32 * 1024);
  return {
    apiKey,
    defaultModelId: bounded(input.defaultModelId, 256),
    endpoint,
    providerId: bounded(input.providerId, 128),
  };
}

function bounded(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("provider_model_catalog_input_invalid");
  }
  return value;
}

async function readInput(): Promise<unknown> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (Buffer.byteLength(line) > MAX_INPUT_BYTES) {
        throw new Error("provider_model_catalog_input_invalid");
      }
      lines.close();
      return JSON.parse(line);
    }
  } catch (error) {
    throw new Error("provider_model_catalog_input_invalid", { cause: error });
  }
  throw new Error("provider_model_catalog_input_invalid");
}

if (process.argv[1]?.endsWith("provider-model-catalog.mjs")) {
  process.stdout.write(
    `${JSON.stringify(await providerModelCatalog(await readInput()))}\n`,
  );
}
