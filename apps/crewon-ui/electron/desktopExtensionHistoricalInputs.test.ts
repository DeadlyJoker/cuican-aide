// @vitest-environment node
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { DatabaseSync } from "node:sqlite";
import {
  compileAgentVersion,
  createAgentVersionAsset,
  type CompiledAgentVersion,
} from "@crewon/agent-version";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDesktopExtensionHistoricalFixture } from "./desktopExtensionHistoricalInputs.test-support.ts";
import { prepareDesktopExtensionHistoricalWorker } from "./desktopExtensionHistoricalInputs.ts";

// The actual archive resolver is independently covered by its filesystem and
// real two-build integration. This nonexecuted port isolates Native input validation.
const archive = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("@crewon/agent-version/extension-build", () => ({
  EXTENSION_HISTORICAL_WORK_ITEM_SCOPE: "crewon.extension-work-item-scope.v1",
  resolveRetainedExtensionBuild: (...args: unknown[]) =>
    archive.resolve(...args),
}));
const roots: string[] = [];
beforeEach(() => {
  archive.resolve.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
async function fixture(
  options: Omit<
    Parameters<typeof createDesktopExtensionHistoricalFixture>[0],
    "dataRoot"
  > = {},
) {
  const dataRoot = mkdtempSync(
    join(realpathSync(tmpdir()), "crewon-historical-inputs-unit-"),
  );
  roots.push(dataRoot);
  const value = await createDesktopExtensionHistoricalFixture({
    dataRoot,
    ...options,
  });
  archive.resolve.mockResolvedValue(value.archive);
  return value;
}
describe("trusted historical Worker inputs", () => {
  it("resolves the exact complete capsule and retained scope, preserves saved inputs and uses only an exact current Provider resolver", async () => {
    const value = await fixture();
    const provider = vi.fn(value.resolveProvider);
    vi.stubEnv("CREWON_MODEL_API_KEY", "ambient-wrong-key");
    vi.stubEnv("CREWON_MODEL_ID", "ambient-wrong-model");
    vi.stubEnv("CREWON_CONTROL_DB_PATH", "/ambient/wrong.sqlite");
    vi.stubEnv("CREWON_CONTROL_SESSION_TOKEN", "ambient-session-secret");
    vi.stubEnv("CREWON_PROVIDER_PROBE_TOKEN", "ambient-probe-secret");
    const result = await prepareDesktopExtensionHistoricalWorker({
      selection: value.selection,
      resolveProvider: provider,
    });
    expect(result.outcome).toBe("ready");
    if (result.outcome !== "ready") throw new Error("fixture_plan_missing");
    expect(archive.resolve).toHaveBeenCalledWith({
      dataRoot: value.selection.dataRoot,
      implementationDigest: value.manifest.implementationDigest,
      expectedBuildIdentityDigest: value.manifest.buildIdentityDigest,
    });
    expect(provider).toHaveBeenCalledWith(value.manifest.providerBinding);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(result.workerPath).toBe(value.archive.bundles[0]!.path);
    expect(result.manifest).toEqual(value.manifest);
    expect(result.environment.CREWON_MODEL_ID).toBe(
      value.bootstrap.model.modelId,
    );
    expect(result.environment.CREWON_MODEL_API_KEY).toBe(
      "unit-current-provider-key",
    );
    expect(result.environment.CREWON_CONTROL_DB_PATH).toBe(
      join(value.selection.dataRoot, "control.sqlite"),
    );
    expect(result.environment.CREWON_EXTENSION_EXECUTION_MODE).toBe(
      "historical",
    );
    expect(result.environment.CREWON_EXTENSION_HOST_TOKEN).toBe(result.token);
    expect(result.environment.CREWON_EXTENSION_HOST_PORT).toBe("0");
    expect(result.environment.CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH).toBe(
      join(value.directory, "base-bindings.json"),
    );
    expect(result.environment.CREWON_EXTENSION_RUNTIME_BINDINGS_PATH).toBe(
      join(value.directory, "plugin-bindings.json"),
    );
    expect(result.environment.CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH).toBe(
      join(value.directory, "plugin-assets.json"),
    );
    expect(
      JSON.parse(result.environment.CREWON_DEV_AGENT_PROFILES_JSON!),
    ).toEqual(value.bootstrap.profiles);
    expect(JSON.parse(result.environment.CREWON_MODEL_CATALOG_JSON!)).toEqual(
      value.bootstrap.modelCatalog,
    );
    expect(
      result.environment.CREWON_RESPONSES_MAX_OUTPUT_TOKENS,
    ).toBeUndefined();
    for (const name of [
      "CREWON_CONTROL_DATABASE_URL",
      "CREWON_CONTROL_SESSION_TOKEN",
      "CREWON_PROVIDER_PROBE_TOKEN",
      "CREWON_EXTENSION_RECOVERY_ATTEMPT_ID",
      "CREWON_EXTENSION_BUILD_ARCHIVE_DATA_ROOT",
      "CREWON_NATIVE_BOOTSTRAP_PATH",
      "CREWON_MCP_STDIO_CONFIG_PATH",
      "CREWON_WORKSPACE_BINDING_ID",
    ])
      expect(result.environment[name]).toBeUndefined();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.environment)).toBe(true);
  });
  it("uses a fresh private token on every plan and redacts key and token from JSON and inspection", async () => {
    const value = await fixture();
    const first = await prepareDesktopExtensionHistoricalWorker({
      selection: value.selection,
      resolveProvider: value.resolveProvider,
    });
    const second = await prepareDesktopExtensionHistoricalWorker({
      selection: value.selection,
      resolveProvider: value.resolveProvider,
    });
    if (first.outcome !== "ready" || second.outcome !== "ready")
      throw new Error("fixture_plan_missing");
    expect(first.token).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.token).not.toBe(second.token);
    for (const rendered of [
      JSON.stringify(first),
      inspect(first),
      JSON.stringify(first.environment),
      inspect(first.environment),
    ]) {
      expect(rendered).not.toContain("unit-current-provider-key");
      expect(rendered).not.toContain(first.token);
      expect(rendered).toContain("[REDACTED]");
    }
  });
  it.each([
    "provider_not_configured",
    "provider_endpoint_mismatch",
    "provider_credentials_unavailable",
    "provider_catalog_invalid",
  ] as const)("does not fall back from current Provider %s", async (reason) => {
    const value = await fixture();
    const result = await prepareDesktopExtensionHistoricalWorker({
      selection: value.selection,
      resolveProvider: () => ({ availability: "unavailable", reason }),
    });
    expect(result).toEqual({
      outcome: "unavailable",
      capsuleId: value.selection.capsuleId,
      reasonCode: "desktop_extension_historical_provider_unavailable",
    });
  });
  it("never injects an available secret into a saved anonymous binding", async () => {
    const value = await fixture({ credentialRequired: false });
    const result = await prepareDesktopExtensionHistoricalWorker({
      selection: value.selection,
      resolveProvider: value.resolveProvider,
    });
    if (result.outcome !== "ready") throw new Error("fixture_plan_missing");
    expect(result.environment.CREWON_MODEL_API_KEY).toBeUndefined();
    expect(result.environment.CREWON_MODEL_CREDENTIAL_REQUIRED).toBe("0");
  });
  it("preserves bounded full bootstrap and profile text with the maximum trusted Provider key without logging it", async () => {
    const value = await fixture({
      profileCount: 8,
      profileInstructions: "p".repeat(9000),
      instructions: "i".repeat(32 * 1024),
      modelCatalog: false,
    });
    const key = "k".repeat(32 * 1024);
    const result = await prepareDesktopExtensionHistoricalWorker({
      selection: value.selection,
      resolveProvider: () => ({ availability: "available", apiKey: key }),
    });
    if (result.outcome !== "ready") throw new Error("fixture_plan_missing");
    expect(result.environment.CREWON_AGENT_INSTRUCTIONS).toHaveLength(
      32 * 1024,
    );
    expect(
      Buffer.byteLength(result.environment.CREWON_DEV_AGENT_PROFILES_JSON!),
    ).toBeGreaterThan(32 * 1024);
    expect(
      JSON.parse(result.environment.CREWON_DEV_AGENT_PROFILES_JSON!),
    ).toEqual(value.bootstrap.profiles);
    expect(result.environment.CREWON_MODEL_API_KEY).toBe(key);
    expect(JSON.stringify(result)).not.toContain(key);
  });
  it("keeps valid long base AgentVersion IDs within the existing 512-byte runtime binding protocol", async () => {
    const value = await fixture({
      profileId: "profile-" + "x".repeat(192),
      modelCatalog: false,
    });
    expect(
      (
        await prepareDesktopExtensionHistoricalWorker({
          selection: value.selection,
          resolveProvider: value.resolveProvider,
        })
      ).outcome,
    ).toBe("ready");
  });
  it("requires a complete marker and rechecks every saved hash before credentials", async () => {
    const partial = await fixture({ complete: false });
    const provider = vi.fn(partial.resolveProvider);
    expect(
      (
        await prepareDesktopExtensionHistoricalWorker({
          selection: partial.selection,
          resolveProvider: provider,
        })
      ).outcome,
    ).toBe("unavailable");
    expect(archive.resolve).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
    const complete = await fixture();
    writeFileSync(join(complete.directory, "snapshot-00.json"), "{}");
    expect(
      (
        await prepareDesktopExtensionHistoricalWorker({
          selection: complete.selection,
          resolveProvider: provider,
        })
      ).outcome,
    ).toBe("unavailable");
    expect(provider).not.toHaveBeenCalled();
  });
  it.each(["crewon.extension-work-item-scope.v0", null, "unknown"])(
    "refuses archive scope %s before obtaining credentials",
    async (historicalWorkItemScope) => {
      const value = await fixture();
      archive.resolve.mockResolvedValue({
        ...value.archive,
        historicalWorkItemScope,
      });
      const provider = vi.fn(value.resolveProvider);
      expect(
        (
          await prepareDesktopExtensionHistoricalWorker({
            selection: value.selection,
            resolveProvider: provider,
          })
        ).outcome,
      ).toBe("unavailable");
      expect(provider).not.toHaveBeenCalled();
    },
  );
  it.each(["implementationDigest", "buildIdentityDigest", "missing-worker"])(
    "refuses retained archive %s mismatch",
    async (mode) => {
      const value = await fixture();
      archive.resolve.mockResolvedValue(
        mode === "missing-worker"
          ? { ...value.archive, bundles: [] }
          : { ...value.archive, [mode]: `sha256:${"f".repeat(64)}` },
      );
      expect(
        (
          await prepareDesktopExtensionHistoricalWorker({
            selection: value.selection,
            resolveProvider: value.resolveProvider,
          })
        ).outcome,
      ).toBe("unavailable");
    },
  );
  it.each(["principalId", "actorId", "tenantId", "spaceId"] as const)(
    "requires the fixed Native owner %s",
    async (field) => {
      const value = await fixture();
      const manifest = {
        ...value.manifest,
        owner: { ...value.manifest.owner, [field]: "wrong-owner" },
      };
      writeFileSync(
        join(value.directory, "manifest.json"),
        JSON.stringify(manifest),
      );
      archive.resolve.mockClear();
      expect(
        (
          await prepareDesktopExtensionHistoricalWorker({
            selection: value.selection,
            resolveProvider: value.resolveProvider,
          })
        ).outcome,
      ).toBe("unavailable");
      expect(archive.resolve).not.toHaveBeenCalled();
    },
  );
  it.each([
    "bootstrap.json",
    "base-bindings.json",
    "plugin-bindings.json",
    "plugin-assets.json",
    "snapshot-00.json",
    "release.json",
  ] as const)(
    "strictly rejects unknown saved %s fields, even when all pins are freshly committed",
    async (file) => {
      const value = await fixture({
        mutate: (documents) => {
          const document = documents.get(file) as Record<string, unknown>;
          documents.set(file, {
            ...document,
            unrecognized: "not-a-launch-input",
          });
        },
      });
      const provider = vi.fn(value.resolveProvider);
      expect(
        (
          await prepareDesktopExtensionHistoricalWorker({
            selection: value.selection,
            resolveProvider: provider,
          })
        ).outcome,
      ).toBe("unavailable");
      expect(provider).not.toHaveBeenCalled();
    },
  );
  it.each([
    "base-provider",
    "plugin-secret-slot",
    "plugin-outside-snapshot",
    "extra-snapshot",
    "profile-instructions",
    "catalog-model",
    "bootstrap-output",
    "saved-target",
  ])("rejects internally pinned %s incoherence", async (mode) => {
    const value = await fixture({
      mutate: (documents, directory) => {
        const base = documents.get("base-bindings.json") as {
          bindings: Array<Record<string, unknown>>;
        };
        const plugin = documents.get("plugin-bindings.json") as {
          bindings: Array<Record<string, unknown>>;
        };
        const bootstrap = documents.get("bootstrap.json") as {
          model: Record<string, unknown>;
          profiles: Array<Record<string, unknown>>;
          modelCatalog: string[];
        };
        if (mode === "base-provider")
          (base.bindings[0]!.provider as { endpoint: string }).endpoint =
            "https://wrong.example/v1/responses";
        if (mode === "plugin-secret-slot")
          (
            plugin.bindings[0]!.provider as { apiKeyEnvironment: string }
          ).apiKeyEnvironment = "ARBITRARY_SECRET";
        if (mode === "plugin-outside-snapshot")
          plugin.bindings[0]!.extensionConfigPath = join(
            directory,
            "..",
            "snapshot-00.json",
          );
        if (mode === "extra-snapshot")
          documents.set("snapshot-01.json", documents.get("snapshot-00.json"));
        if (mode === "profile-instructions")
          bootstrap.profiles[0]!.instructions = "drifted profile instructions";
        if (mode === "catalog-model") bootstrap.modelCatalog[1] = "other-model";
        if (mode === "bootstrap-output") bootstrap.model.maxOutputTokens = 500;
        if (mode === "saved-target")
          plugin.bindings[0]!.authorityId = "other-authority";
      },
    });
    expect(
      (
        await prepareDesktopExtensionHistoricalWorker({
          selection: value.selection,
          resolveProvider: value.resolveProvider,
        })
      ).outcome,
    ).toBe("unavailable");
  });
  it("captures selection and resolver before filesystem awaits and propagates caller abort", async () => {
    const value = await fixture();
    const mutable = {
      selection: { ...value.selection },
      resolveProvider: value.resolveProvider,
    };
    const pending = prepareDesktopExtensionHistoricalWorker(mutable);
    mutable.selection.dataRoot = join(value.selection.dataRoot, "wrong");
    mutable.selection.capsuleId = `sha256:${"f".repeat(64)}`;
    mutable.resolveProvider = () => ({
      availability: "available",
      apiKey: "wrong-later-key",
    });
    const result = await pending;
    if (result.outcome !== "ready") throw new Error("fixture_plan_missing");
    expect(result.environment.CREWON_MODEL_API_KEY).toBe(
      "unit-current-provider-key",
    );
    const aborted = AbortSignal.abort(new Error("fixture-stop"));
    await expect(
      prepareDesktopExtensionHistoricalWorker({
        selection: value.selection,
        resolveProvider: value.resolveProvider,
        signal: aborted,
      }),
    ).rejects.toThrow("fixture-stop");
    expect(
      readFileSync(join(value.directory, "bootstrap.json"), "utf8"),
    ).not.toContain("unit-current-provider-key");
  });
  it.each([
    "bootstrap-asset",
    "profile-asset",
    "model-variant-asset",
    "plugin-asset",
    "deployment",
    "bundle",
  ])(
    "requires the complete original database %s without creating or repairing anything",
    async (mode) => {
      const value = await fixture();
      const database = new DatabaseSync(value.databasePath);
      database.exec("PRAGMA foreign_keys=OFF");
      try {
        const id =
          mode === "bootstrap-asset"
            ? "saved-default"
            : mode === "profile-asset"
              ? "saved-profile"
              : mode === "plugin-asset"
                ? "saved-plugin"
                : mode === "model-variant-asset"
                  ? `saved-default:model-${createHash("sha256").update("model-b").digest("hex").slice(0, 24)}`
                  : "saved-profile";
        if (mode === "bundle")
          database
            .prepare(
              "DELETE FROM agent_version_release_bundles WHERE release_id=?",
            )
            .run(value.manifest.releaseId);
        else
          database
            .prepare(
              `DELETE FROM ${mode === "deployment" ? "agent_version_deployments" : "agent_versions"} WHERE agent_version_id=?`,
            )
            .run(id);
      } finally {
        database.close();
      }
      const before = readFileSync(value.databasePath);
      const provider = vi.fn(value.resolveProvider);
      expect(
        (
          await prepareDesktopExtensionHistoricalWorker({
            selection: value.selection,
            resolveProvider: provider,
          })
        ).outcome,
      ).toBe("unavailable");
      expect(provider).not.toHaveBeenCalled();
      expect(readFileSync(value.databasePath)).toEqual(before);
    },
  );
  it("recompiles and compares a valid changed persisted profile definition rather than trusting its digest columns", async () => {
    const value = await fixture();
    const plan = (
      value.documents.get("release.json") as {
        plan: { versions: CompiledAgentVersion[] };
      }
    ).plan;
    const original = plan.versions.find(
      (version) => version.agentVersionId === "saved-profile",
    )!;
    const { contentDigest: _digest, ...definition } = original;
    const changed = compileAgentVersion(
      {
        ...definition,
        schemaVersion: "crewon.agent-version-source.v0",
        instructions: "different valid persisted profile",
      },
      {
        sha256: (input) =>
          `sha256:${createHash("sha256").update(input).digest("hex")}`,
      },
    );
    const asset = createAgentVersionAsset({
      tenantId: value.manifest.owner.tenantId,
      version: changed,
      createdAt: "2026-10-03T00:00:00.000Z",
    });
    const database = new DatabaseSync(value.databasePath);
    try {
      database
        .prepare(
          "UPDATE agent_versions SET content_digest=?,asset_json=? WHERE agent_version_id=?",
        )
        .run(asset.contentDigest, JSON.stringify(asset), asset.agentVersionId);
    } finally {
      database.close();
    }
    const provider = vi.fn(value.resolveProvider);
    expect(
      (
        await prepareDesktopExtensionHistoricalWorker({
          selection: value.selection,
          resolveProvider: provider,
        })
      ).outcome,
    ).toBe("unavailable");
    expect(provider).not.toHaveBeenCalled();
  });
});
