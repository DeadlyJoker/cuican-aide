import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderCredentialStore } from "./providerCredentials.ts";
import { providerModelCatalogForForm } from "./providerModelCatalog.ts";
import { desktopFinancialEnvironmentFixture } from "./desktopPluginCreditSettlementEnvironment.test-support.ts";

afterEach(() => vi.unstubAllEnvs());

it("original model catalogue launch removes exactly declared financial refs before spawning its bounded probe", async () => {
  const f = desktopFinancialEnvironmentFixture();
  const modelCatalog = join(f.directory, "catalogue.mjs");
  const audit = join(f.directory, "catalogue-environment.jsonl");
  writeFileSync(
    modelCatalog,
    f.childAudit(audit, "catalogue") +
      `
process.stdin.resume();
process.stdin.once('data', () => {
  process.stdout.write(JSON.stringify({models:['named-catalogue-model'],status:'ok'})+String.fromCharCode(10));
});
`,
  );
  for (const [name, value] of Object.entries(f.environment))
    vi.stubEnv(name, value);
  try {
    const secretFor = vi.fn(() => null);
    const result = await providerModelCatalogForForm(
      {
        apiKey: "named-model-probe-token",
        defaultModelId: "named-catalogue-model",
        endpoint: "https://model.example/v1",
        environmentVariable: null,
        providerId: "named-model-provider",
      },
      {
        providers: { secretFor } as unknown as ProviderCredentialStore,
        paths: {
          source: false,
          modelCatalog,
          control: "/unused/control",
          worker: "/unused/worker",
          release: "/unused/release",
          workspaceMcp: "/unused/mcp",
        },
      },
    );
    expect(result).toEqual({ models: ["named-catalogue-model"], status: "ok" });
    expect(JSON.parse(readFileSync(audit, "utf8").trim())).toEqual({
      kind: "catalogue",
      path: null,
      authorization: null,
      decision: null,
      unrelated: f.environment.CREWON_FINANCIAL_UNDECLARED_TOKEN,
    });
    expect(secretFor).not.toHaveBeenCalled();
  } finally {
    f.cleanup();
  }
});
