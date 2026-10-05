import { describe, expect, it, vi } from "vitest";
import type { ActiveProvider } from "./providerCredentials.ts";
import { withDesktopProviderProbeEnvironment } from "./desktopProviderProbeEnvironment.ts";
import { resolveRuntimeProviderProbeEnvironment } from "../../runtime-worker/src/runtime-provider-probe-environment.ts";
import { DesktopProviderProbeEgressPolicy } from "../../runtime-worker/src/provider-probe-egress.ts";
import { resolveStandaloneProviderProbeWorkers } from "../../control-api/src/standalone-provider-probe-environment.ts";

const apiKey = "fixture-real-configured-key-at-least-32-bytes";
const token = "fixture-private-probe-token-at-least-32-bytes";
const provider: ActiveProvider = Object.freeze({
  providerId: "fixture-provider",
  endpoint: "https://models.example/v1",
  modelId: "fixture-model",
  apiKey,
});
const fields = [
  "CREWON_PROVIDER_PROBE_CREDENTIAL_ENVIRONMENT",
  "CREWON_PROVIDER_PROBE_ENDPOINT",
  "CREWON_PROVIDER_PROBE_PORT",
  "CREWON_PROVIDER_PROBE_PROVIDER_ID",
  "CREWON_PROVIDER_PROBE_RUNTIME_BINDING_ID",
  "CREWON_PROVIDER_PROBE_TOKEN",
  "CREWON_PROVIDER_PROBE_WORKER_ORIGIN",
  "CREWON_PROVIDER_PROBE_WORKER_TOKEN",
] as const;
const projection = (active: ActiveProvider, environment: NodeJS.ProcessEnv) =>
  withDesktopProviderProbeEnvironment({
    environment,
    provider: active,
    port: 43210,
    token,
    runtimeBindingId: "desktop-fixture-runtime",
  });

describe("desktop private provider probe environment", () => {
  it("omits private Worker and Control probe declarations for a legitimate no-credential provider", () => {
    const input = Object.freeze({
      CREWON_MODEL_API_KEY: "",
      CREWON_MODEL_ID: provider.modelId,
      NODE_ENV: "production",
    });
    const output = projection({ ...provider, apiKey: null }, input);
    expect(output).toEqual(input);
    expect(output).not.toBe(input);
    for (const name of fields) expect(Object.hasOwn(output, name)).toBe(false);
    expect(
      resolveRuntimeProviderProbeEnvironment(
        output,
        "standalone",
        new DesktopProviderProbeEgressPolicy(),
      ),
    ).toBeUndefined();
    expect(
      resolveStandaloneProviderProbeWorkers(
        output,
        "standalone",
        "fixture-tenant",
      ),
    ).toBeUndefined();
    expect(
      resolveRuntimeProviderProbeEnvironment(
        output,
        "production",
        new DesktopProviderProbeEgressPolicy(),
      ),
    ).toBeUndefined();
    expect(
      resolveStandaloneProviderProbeWorkers(
        output,
        "production",
        "fixture-tenant",
      ),
    ).toBeUndefined();
  });

  it("strips all eight ambient declarations without modifying its input or inventing a credential", () => {
    const ambient: Readonly<NodeJS.ProcessEnv> = Object.freeze({
      PATH: "/fixture/path",
      CREWON_MODEL_API_KEY: "",
      ...Object.fromEntries(fields.map((name) => [name, "ambient-canary"])),
    });
    const output = projection({ ...provider, apiKey: null }, ambient);
    expect(output).toEqual({ PATH: "/fixture/path", CREWON_MODEL_API_KEY: "" });
    for (const name of fields) expect(ambient[name]).toBe("ambient-canary");
    expect(
      resolveRuntimeProviderProbeEnvironment(
        output,
        "standalone",
        new DesktopProviderProbeEgressPolicy(),
      ),
    ).toBeUndefined();
    expect(
      resolveStandaloneProviderProbeWorkers(
        output,
        "standalone",
        "fixture-tenant",
      ),
    ).toBeUndefined();
  });

  it("replaces ambient declarations with the exact original complete keyed binding and resolver", async () => {
    const environment = Object.freeze({
      PATH: "/fixture/path",
      CREWON_MODEL_API_KEY: apiKey,
      ...Object.fromEntries(fields.map((name) => [name, "ambient-canary"])),
    });
    const output = projection(provider, environment);
    expect(output).toEqual({
      PATH: "/fixture/path",
      CREWON_MODEL_API_KEY: apiKey,
      CREWON_PROVIDER_PROBE_CREDENTIAL_ENVIRONMENT: "CREWON_MODEL_API_KEY",
      CREWON_PROVIDER_PROBE_ENDPOINT: provider.endpoint,
      CREWON_PROVIDER_PROBE_PORT: "43210",
      CREWON_PROVIDER_PROBE_PROVIDER_ID: provider.providerId,
      CREWON_PROVIDER_PROBE_RUNTIME_BINDING_ID: "desktop-fixture-runtime",
      CREWON_PROVIDER_PROBE_TOKEN: token,
      CREWON_PROVIDER_PROBE_WORKER_ORIGIN: "http://127.0.0.1:43210",
      CREWON_PROVIDER_PROBE_WORKER_TOKEN: token,
    });
    const fetch = vi.spyOn(globalThis, "fetch");
    try {
      const parsed = resolveRuntimeProviderProbeEnvironment(
        output,
        "standalone",
        new DesktopProviderProbeEgressPolicy(),
      )!;
      expect(parsed.runtimeBinding).toEqual({
        providerId: provider.providerId,
        runtimeBindingId: "desktop-fixture-runtime",
        endpoint: provider.endpoint,
        credentialKind: "environment",
        environmentVariable: "CREWON_MODEL_API_KEY",
      });
      expect(parsed.port).toBe(43210);
      expect(parsed.token).toBe(token);
      const lease = await parsed.secrets.resolve(
        parsed.runtimeBinding,
        new AbortController().signal,
      );
      expect(lease?.value).toBe(apiKey);
      lease?.release();
      expect(
        resolveStandaloneProviderProbeWorkers(
          output,
          "standalone",
          "fixture-tenant",
        ),
      ).toBeDefined();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it("keeps the original production prohibition for a keyed private probe", () => {
    const output = projection(provider, { CREWON_MODEL_API_KEY: apiKey });
    expect(() =>
      resolveRuntimeProviderProbeEnvironment(
        output,
        "production",
        new DesktopProviderProbeEgressPolicy(),
      ),
    ).toThrow("CONFIGURATION_forbidden");
    expect(() =>
      resolveStandaloneProviderProbeWorkers(
        output,
        "production",
        "fixture-tenant",
      ),
    ).toThrow("CONFIGURATION_forbidden");
  });

  it("removes an ambient optional Control timeout only for a no-credential provider", () => {
    const ambient = {
      CREWON_MODEL_API_KEY: "",
      CREWON_PROVIDER_PROBE_WORKER_TIMEOUT_MS: "12000",
    };
    const omitted = projection({ ...provider, apiKey: null }, ambient);
    expect(
      Object.hasOwn(omitted, "CREWON_PROVIDER_PROBE_WORKER_TIMEOUT_MS"),
    ).toBe(false);
    expect(
      resolveStandaloneProviderProbeWorkers(
        omitted,
        "standalone",
        "fixture-tenant",
      ),
    ).toBeUndefined();
    expect(ambient.CREWON_PROVIDER_PROBE_WORKER_TIMEOUT_MS).toBe("12000");
    const keyed = projection(provider, {
      ...ambient,
      CREWON_MODEL_API_KEY: apiKey,
    });
    expect(keyed.CREWON_PROVIDER_PROBE_WORKER_TIMEOUT_MS).toBe("12000");
    expect(
      resolveStandaloneProviderProbeWorkers(
        keyed,
        "standalone",
        "fixture-tenant",
      ),
    ).toBeDefined();
  });

  it.each(["", "short-key"])(
    "does not replace an invalid %s credential with a fabricated probe secret",
    (key) => {
      const output = projection(
        { ...provider, apiKey: key },
        { CREWON_MODEL_API_KEY: key },
      );
      expect(output.CREWON_MODEL_API_KEY).toBe(key);
      expect(() =>
        resolveRuntimeProviderProbeEnvironment(
          output,
          "standalone",
          new DesktopProviderProbeEgressPolicy(),
        ),
      ).toThrow("CONFIGURATION_invalid");
    },
  );
});
