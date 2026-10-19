import { describe, expect, it, vi } from "vitest";
import {
  DesktopRuntimeModelCatalogDiscovery,
  DESKTOP_RUNTIME_MODEL_CATALOG_REUSE_MS,
  type DesktopModelDiscoveryContext,
} from "./desktopRuntimeModelCatalogDiscovery.ts";
import type { ActiveProvider } from "./providerCredentials.ts";
import type { ProviderModelCatalogOutcome } from "./providerModelCatalog.ts";

const provider: ActiveProvider = {
  providerId: "fixture-provider",
  endpoint: "https://fixture.invalid/v1",
  modelId: "fixture-model",
  apiKey: "named-fixture-key",
};
const context = (): DesktopModelDiscoveryContext => ({
  entry: "/fixture/catalog.mjs",
  source: false,
  environment: {
    ELECTRON_RUN_AS_NODE: "1",
    HTTPS_PROXY: "https://fixture-proxy.invalid",
  },
  credentialSource: { kind: "keychain", environmentVariable: null },
});

function fixture() {
  let now = 0;
  let discoveryContext = context();
  const discover = vi.fn(
    async (
      _provider: ActiveProvider,
    ): Promise<ProviderModelCatalogOutcome> => ({
      status: "ok",
      models: ["fixture-model"],
    }),
  );
  const options = { discover, context: () => discoveryContext, now: () => now };
  return {
    discover,
    owner: new DesktopRuntimeModelCatalogDiscovery(options),
    newMain: () => new DesktopRuntimeModelCatalogDiscovery(options),
    setTime: (value: number) => {
      now = value;
    },
    setContext: (value: DesktopModelDiscoveryContext) => {
      discoveryContext = value;
    },
  };
}

describe("short-lived Main model discovery metadata", () => {
  it("reuses only a recent successful result in one Main lifetime, with an exact finite clock boundary", async () => {
    const f = fixture();
    await expect(f.owner.discover(provider)).resolves.toEqual([
      "fixture-model",
    ]);
    f.setTime(DESKTOP_RUNTIME_MODEL_CATALOG_REUSE_MS - 1);
    await f.owner.discover(provider);
    expect(f.discover).toHaveBeenCalledTimes(1);
    f.setTime(DESKTOP_RUNTIME_MODEL_CATALOG_REUSE_MS);
    await f.owner.discover(provider);
    expect(f.discover).toHaveBeenCalledTimes(2);
    await f.newMain().discover(provider);
    expect(f.discover).toHaveBeenCalledTimes(3);
    f.setTime(0);
    await f.owner.discover(provider);
    expect(f.discover).toHaveBeenCalledTimes(4);
  });

  it.each([
    { ...provider, providerId: "changed-provider" },
    { ...provider, endpoint: "https://other.invalid/v1" },
    { ...provider, modelId: "changed-model" },
    { ...provider, apiKey: "changed-fixture-key" },
    { ...provider, apiKey: null },
  ])(
    "invalidates every changed provider/discovery field without retaining an older identity %j",
    async (changed) => {
      const f = fixture();
      await f.owner.discover(provider);
      await f.owner.discover(changed);
      await f.owner.discover(provider);
      expect(f.discover).toHaveBeenCalledTimes(3);
    },
  );

  it.each([
    { ...context(), entry: "/fixture/new-catalog.mjs" },
    { ...context(), source: true },
    {
      ...context(),
      environment: {
        ...context().environment,
        HTTPS_PROXY: "https://new-proxy.invalid",
      },
    },
    {
      ...context(),
      environment: { ...context().environment, NO_PROXY: "fixture.invalid" },
    },
    {
      ...context(),
      environment: {
        ...context().environment,
        NODE_OPTIONS: "--use-env-proxy",
      },
    },
    {
      ...context(),
      credentialSource: {
        kind: "environment",
        environmentVariable: "FIXTURE_MODEL_KEY",
      },
    },
    {
      ...context(),
      credentialSource: {
        kind: "keychain",
        environmentVariable: "CHANGED_FIXTURE_KEY",
      },
    },
  ])(
    "invalidates changed network, credential source or executable discovery parameters %j",
    async (changed) => {
      const f = fixture();
      await f.owner.discover(provider);
      f.setContext(changed);
      await f.owner.discover(provider);
      expect(f.discover).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    "credentialMissing",
    "authenticationFailed",
    "bindingMismatch",
    "rateLimited",
    "providerError",
    "unreachable",
    "invalidResponse",
  ])(
    "does not retain %s as a successful discovery or keep a prior result after it",
    async (status) => {
      const f = fixture();
      await f.owner.discover(provider);
      f.setTime(DESKTOP_RUNTIME_MODEL_CATALOG_REUSE_MS);
      f.discover.mockResolvedValueOnce({ status, models: [] });
      await f.owner.discover(provider);
      f.discover.mockResolvedValueOnce({ status: "ok", models: ["new-model"] });
      await expect(f.owner.discover(provider)).resolves.toEqual(["new-model"]);
      expect(f.discover).toHaveBeenCalledTimes(3);
    },
  );

  it("keeps successful empty discovery distinct from failed discovery and never retains a thrown probe", async () => {
    const f = fixture();
    f.discover.mockResolvedValueOnce({ status: "ok", models: [] });
    await expect(f.owner.discover(provider)).resolves.toEqual([]);
    await expect(f.owner.discover(provider)).resolves.toEqual([]);
    expect(f.discover).toHaveBeenCalledTimes(1);
    f.setTime(DESKTOP_RUNTIME_MODEL_CATALOG_REUSE_MS);
    f.discover.mockRejectedValueOnce(new Error("named-probe-failure"));
    await expect(f.owner.discover(provider)).rejects.toThrow(
      "named-probe-failure",
    );
    await f.owner.discover(provider);
    expect(f.discover).toHaveBeenCalledTimes(3);
  });

  it("does not retain a result when discovery context changes in flight or let an older probe replace the newer slot", async () => {
    const f = fixture();
    let finish!: (outcome: ProviderModelCatalogOutcome) => void;
    f.discover.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const older = f.owner.discover(provider);
    f.setContext({ ...context(), source: true });
    finish({ status: "ok", models: ["old-model"] });
    await older;
    await f.owner.discover(provider);
    expect(f.discover).toHaveBeenCalledTimes(2);
    f.setTime(DESKTOP_RUNTIME_MODEL_CATALOG_REUSE_MS);
    f.discover.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const late = f.owner.discover(provider);
    const changed = { ...provider, apiKey: "rotated-key" };
    await f.owner.discover(changed);
    finish({ status: "ok", models: ["late-old-model"] });
    await late;
    await f.owner.discover(changed);
    expect(f.discover).toHaveBeenCalledTimes(4);
  });
});
