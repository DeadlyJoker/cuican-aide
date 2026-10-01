// @vitest-environment node
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDesktopExtensionCurrentUpgradeFixture,
  duplicateDesktopExtensionCurrentUpgradeCandidate,
} from "./desktopExtensionCurrentUpgradeInputs.test-support.ts";
import { prepareDesktopExtensionCurrentUpgradeInputs } from "./desktopExtensionCurrentUpgradeInputs.ts";
import { desktopExtensionRuntimeEnvironments } from "./desktopExtensionRuntime.ts";
import { historicalFixtureDigest as hash } from "./desktopExtensionHistoricalInputs.test-support.ts";

// The old archive is a nonexecuted unit port. Current seven-file verification,
// original-input matching, complete capsule IO and full SQLite checks are real.
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
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
async function fixture(original = false) {
  const dataRoot = mkdtempSync(
    join(realpathSync(tmpdir()), "crewon-current-upgrade-unit-"),
  );
  roots.push(dataRoot);
  const value = await createDesktopExtensionCurrentUpgradeFixture({
    dataRoot,
    original,
  });
  archive.resolve.mockResolvedValue(value.archive);
  const resolveProvider = vi.fn(value.resolveProvider);
  const input = {
    dataRoot,
    currentBuildDirectory: value.currentBuildDirectory,
    source: false,
    configuration: value.configuration,
    environments: value.environments,
    resolveProvider,
  };
  return { ...value, resolveProvider, input };
}
const names = [
  "CREWON_EXTENSION_RUNTIME_BINDINGS_PATH",
  "CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH",
] as const;
function identity(value: Awaited<ReturnType<typeof fixture>>) {
  const path = join(
    value.currentBuildDirectory,
    "extension-build-identity.json",
  );
  return { path, value: JSON.parse(readFileSync(path, "utf8")) };
}
function expectUnchanged(
  result: Awaited<
    ReturnType<typeof prepareDesktopExtensionCurrentUpgradeInputs>
  >,
  value: Awaited<ReturnType<typeof fixture>>,
) {
  expect(result.outcome).toBe("unchanged");
  expect(result.environments).toEqual(value.environments);
  for (const name of names) {
    expect(result.environments.release[name]).toBe(
      value.environments.release[name],
    );
    expect(result.environments.worker[name]).toBe(
      value.environments.worker[name],
    );
  }
  expect(result).not.toHaveProperty("capsuleId");
}

describe("current build isolation of verified historical plugin inputs", () => {
  it.each([false, true])(
    "isolates %s original-mode inputs only after full material proof, without writing state or returning old credentials",
    async (original) => {
      const value = await fixture(original);
      const preserved = new Map(
        [
          value.configurationPath,
          value.databasePath,
          ...value.manifest.files.map(({ file }) =>
            join(value.directory, file),
          ),
          join(value.directory, "manifest.json"),
          value.configuration.runtimeBindingsPath,
          value.configuration.agentVersionAssetsPath,
        ].map((path) => [path, readFileSync(path)]),
      );
      const result = await prepareDesktopExtensionCurrentUpgradeInputs(
        value.input,
      );
      expect(result.outcome).toBe("historyOnly");
      if (result.outcome !== "historyOnly")
        throw new Error("fixture_upgrade_missing");
      expect(result.capsuleId).toBe(value.manifest.capsuleId);
      expect(result.reasonCode).toBe(
        "desktop_extension_current_upgrade_history_only",
      );
      for (const [before, after] of [
        [value.environments.release, result.environments.release],
        [value.environments.worker, result.environments.worker],
      ]) {
        const expected = { ...before };
        for (const name of names) delete expected[name];
        expect(after).toEqual(expected);
      }
      expect(result.environments.control).toBe(value.environments.control);
      expect(result.environments.control("http://127.0.0.1:45123")).toEqual(
        value.environments.control("http://127.0.0.1:45123"),
      );
      expect(result.environments).toMatchObject({
        enabled: true,
        token: value.environments.enabled
          ? value.environments.token
          : undefined,
      });
      expect(value.resolveProvider).toHaveBeenCalledTimes(2);
      expect(value.resolveProvider).toHaveBeenNthCalledWith(
        1,
        value.manifest.providerBinding,
      );
      expect(value.resolveProvider).toHaveBeenNthCalledWith(
        2,
        value.manifest.providerBinding,
      );
      expect(JSON.stringify(result)).not.toContain("unit-current-provider-key");
      expect(result).not.toHaveProperty("manifest");
      expect(result).not.toHaveProperty("workerPath");
      for (const [path, bytes] of preserved)
        expect(readFileSync(path)).toEqual(bytes);
    },
  );
  it.each(["source", "disabled", "metadata"] as const)(
    "keeps %s startup unchanged without inspecting nonexistent build or capsule paths",
    async (kind) => {
      const value = await fixture();
      const configuration =
        kind === "disabled"
          ? {
              schemaVersion: "crewon.desktop-extension-runtime.v0" as const,
              enabled: false as const,
            }
          : {
              ...value.configuration,
              runtimeBindingsPath: null,
              agentVersionAssetsPath: null,
            };
      const environments =
        kind === "source"
          ? value.environments
          : desktopExtensionRuntimeEnvironments({
              configuration,
              sharedEnvironment: {},
              workerEnvironment: {},
            });
      const result = await prepareDesktopExtensionCurrentUpgradeInputs({
        ...value.input,
        source: kind === "source",
        configuration,
        environments,
        currentBuildDirectory: "/does/not/exist",
      });
      expect(result).toEqual({
        outcome: "unchanged",
        environments,
        reasonCode: null,
      });
      expect(archive.resolve).not.toHaveBeenCalled();
      expect(value.resolveProvider).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["CREWON_PRINCIPAL_ID", "other"],
    ["CREWON_ACTOR_ID", "other"],
    ["CREWON_TENANT_ID", "other"],
    ["CREWON_SPACE_ID", "other"],
    ["CREWON_CONTROL_SECURITY_MODE", "production"],
    ["CREWON_CONTROL_DB_PATH", "/foreign/control.sqlite"],
    ["CREWON_CONTROL_DATABASE_URL", "postgres://secret"],
    ["CREWON_CONTROL_DATABASE_SCHEMA", "foreign"],
    ["CREWON_EXTENSIONS_ENABLED", "0"],
    ["CREWON_EXTENSION_RUNTIME_BINDINGS_PATH", "/foreign/bindings.json"],
    ["CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH", "/foreign/assets.json"],
  ])(
    "keeps scope mismatch %s on its original strict release path",
    async (name, replacement) => {
      const value = await fixture();
      value.input.environments = {
        ...value.environments,
        worker: { ...value.environments.worker, [name!]: replacement },
      };
      const result = await prepareDesktopExtensionCurrentUpgradeInputs(
        value.input,
      );
      expect(result).toEqual({
        outcome: "unchanged",
        environments: value.input.environments,
        reasonCode: "desktop_extension_current_upgrade_unavailable",
      });
      expect(value.resolveProvider).not.toHaveBeenCalled();
      expect(archive.resolve).not.toHaveBeenCalled();
      expect(JSON.stringify(result.reasonCode)).not.toContain("secret");
    },
  );
  it("requires the current native archive root to match the DB owner root", async () => {
    const value = await fixture();
    value.input.environments = {
      ...value.environments,
      release: {
        ...value.environments.release,
        CREWON_EXTENSION_BUILD_ARCHIVE_DATA_ROOT: "/other/root",
      },
    };
    const result = await prepareDesktopExtensionCurrentUpgradeInputs(
      value.input,
    );
    expect(result.outcome).toBe("unchanged");
    expect(value.resolveProvider).not.toHaveBeenCalled();
  });
  it.each(["CREWON_RELEASE_PRINCIPAL_ID", "CREWON_RELEASE_ACTOR_ID"])(
    "requires Native release publisher %s",
    async (name) => {
      const value = await fixture();
      const environments = {
        ...value.environments,
        release: { ...value.environments.release, [name]: "foreign-publisher" },
      };
      const result = await prepareDesktopExtensionCurrentUpgradeInputs({
        ...value.input,
        environments,
      });
      expect(result).toEqual({
        outcome: "unchanged",
        environments,
        reasonCode: "desktop_extension_current_upgrade_unavailable",
      });
      expect(value.resolveProvider).not.toHaveBeenCalled();
    },
  );
  it("does not isolate configuration for the same source build", async () => {
    const value = await fixture();
    const sidecar = identity(value);
    sidecar.value.implementationDigest = value.manifest.implementationDigest;
    writeFileSync(sidecar.path, JSON.stringify(sidecar.value));
    expectUnchanged(
      await prepareDesktopExtensionCurrentUpgradeInputs(value.input),
      value,
    );
    expect(value.resolveProvider).not.toHaveBeenCalled();
  });
  it("never selects the first of two exactly matched complete old capsules", async () => {
    const value = await fixture(true);
    await duplicateDesktopExtensionCurrentUpgradeCandidate(value);
    expectUnchanged(
      await prepareDesktopExtensionCurrentUpgradeInputs(value.input),
      value,
    );
    expect(value.resolveProvider).not.toHaveBeenCalled();
    expect(archive.resolve).not.toHaveBeenCalled();
  });
  it.each(["tamper", "missing", "old-scope", "unknown-key"] as const)(
    "rejects installed seven-file proof %s without executing or retaining it",
    async (kind) => {
      const value = await fixture();
      const sidecar = identity(value);
      if (kind === "tamper")
        writeFileSync(
          join(value.currentBuildDirectory, "control-api.mjs"),
          "tampered",
        );
      else if (kind === "missing")
        rmSync(join(value.currentBuildDirectory, "device-gateway.mjs"));
      else {
        if (kind === "old-scope")
          sidecar.value.historicalWorkItemScope =
            "crewon.extension-work-item-scope.v0";
        else sidecar.value.secret = "never-log";
        writeFileSync(sidecar.path, JSON.stringify(sidecar.value));
      }
      const result = await prepareDesktopExtensionCurrentUpgradeInputs(
        value.input,
      );
      expectUnchanged(result, value);
      expect(value.resolveProvider).not.toHaveBeenCalled();
      expect(result.reasonCode).toBe(
        "desktop_extension_current_upgrade_unavailable",
      );
    },
  );
  it.each(["bindings", "assets", "snapshot"] as const)(
    "does not match changed original %s bytes",
    async (file) => {
      const value = await fixture(true);
      const path =
        file === "bindings"
          ? value.configuration.runtimeBindingsPath
          : file === "assets"
            ? value.configuration.agentVersionAssetsPath
            : join(value.selection.dataRoot, "operator", "snapshot.json");
      writeFileSync(path, `${readFileSync(path, "utf8")} `);
      expectUnchanged(
        await prepareDesktopExtensionCurrentUpgradeInputs(value.input),
        value,
      );
      expect(value.resolveProvider).not.toHaveBeenCalled();
    },
  );
  it.each([
    "missing",
    "partial",
    "tampered",
    "foreign-owner",
    "unexpected-directory",
  ] as const)(
    "keeps %s saved capsule on the strict original path",
    async (kind) => {
      const value = await fixture();
      const marker = join(value.directory, "manifest.json");
      if (kind === "missing") rmSync(value.directory, { recursive: true });
      if (kind === "partial") rmSync(marker);
      if (kind === "tampered")
        writeFileSync(join(value.directory, "snapshot-00.json"), "{}");
      if (kind === "foreign-owner") {
        const manifest = JSON.parse(readFileSync(marker, "utf8"));
        manifest.owner.actorId = "foreign-actor";
        writeFileSync(marker, JSON.stringify(manifest));
      }
      if (kind === "unexpected-directory")
        mkdirSync(
          join(value.selection.dataRoot, "extension-recoveries", "unknown"),
        );
      expectUnchanged(
        await prepareDesktopExtensionCurrentUpgradeInputs(value.input),
        value,
      );
      expect(value.resolveProvider).not.toHaveBeenCalled();
    },
  );
  it("rejects legacy historical scope despite a matching complete capsule", async () => {
    const value = await fixture();
    archive.resolve.mockResolvedValue({
      ...value.archive,
      historicalWorkItemScope: "crewon.extension-work-item-scope.v0",
    });
    expectUnchanged(
      await prepareDesktopExtensionCurrentUpgradeInputs(value.input),
      value,
    );
    expect(value.resolveProvider).not.toHaveBeenCalled();
  });
  it.each([
    "saved-default",
    "saved-profile",
    "saved-profile:model-" + hash("model-b").slice(7, 31),
    "saved-plugin",
  ])("requires every published asset including %s", async (id) => {
    const value = await fixture();
    const db = new DatabaseSync(value.databasePath);
    try {
      // Deliberately corrupt the existing database; the reader must not repair it.
      db.exec("PRAGMA foreign_keys=OFF");
      db.prepare("DELETE FROM agent_versions WHERE agent_version_id=?").run(id);
    } finally {
      db.close();
    }
    expectUnchanged(
      await prepareDesktopExtensionCurrentUpgradeInputs(value.input),
      value,
    );
    expect(value.resolveProvider).not.toHaveBeenCalled();
  });
  it.each(["deployment", "bundle"] as const)(
    "requires published %s without migration or repair",
    async (kind) => {
      const value = await fixture();
      const db = new DatabaseSync(value.databasePath);
      try {
        db.exec("PRAGMA foreign_keys=OFF");
        db.exec(
          kind === "deployment"
            ? "DELETE FROM agent_version_deployments WHERE agent_version_id='saved-plugin'"
            : "DELETE FROM agent_version_release_bundles",
        );
      } finally {
        db.close();
      }
      const before = readFileSync(value.databasePath);
      expectUnchanged(
        await prepareDesktopExtensionCurrentUpgradeInputs(value.input),
        value,
      );
      expect(readFileSync(value.databasePath)).toEqual(before);
      expect(value.resolveProvider).not.toHaveBeenCalled();
    },
  );
  it.each([
    "provider_not_configured",
    "provider_endpoint_mismatch",
    "provider_credentials_unavailable",
    "provider_catalog_invalid",
  ] as const)(
    "does not fall back from exact current Provider %s",
    async (reason) => {
      const value = await fixture();
      const result = await prepareDesktopExtensionCurrentUpgradeInputs({
        ...value.input,
        resolveProvider: () => ({ availability: "unavailable", reason }),
      });
      expectUnchanged(result, value);
      expect(result.reasonCode).toBe(
        "desktop_extension_current_upgrade_unavailable",
      );
    },
  );
  it.each(["installed", "original", "complete-marker"] as const)(
    "rechecks %s after credential/material qualification",
    async (kind) => {
      const value = await fixture(true);
      const result = await prepareDesktopExtensionCurrentUpgradeInputs({
        ...value.input,
        resolveProvider: () => {
          const path =
            kind === "installed"
              ? join(value.currentBuildDirectory, "control-api.mjs")
              : kind === "original"
                ? value.configuration.agentVersionAssetsPath
                : join(value.directory, "manifest.json");
          if (kind === "complete-marker") {
            const marker = JSON.parse(readFileSync(path, "utf8"));
            marker.files[0].digest = hash("changed saved input pin");
            writeFileSync(path, JSON.stringify(marker));
          } else writeFileSync(path, `${readFileSync(path, "utf8")} `);
          return value.resolveProvider();
        },
      });
      expectUnchanged(result, value);
    },
  );
  it.each([
    "provider_endpoint_mismatch",
    "provider_credentials_unavailable",
  ] as const)(
    "rechecks exact Provider %s after the first material proof",
    async (reason) => {
      const value = await fixture();
      let available = true;
      let archiveReads = 0;
      archive.resolve.mockImplementation(async () => {
        if (++archiveReads === 2) available = false;
        return value.archive;
      });
      const resolveProvider = vi.fn(() =>
        available
          ? value.resolveProvider()
          : { availability: "unavailable" as const, reason },
      );
      expectUnchanged(
        await prepareDesktopExtensionCurrentUpgradeInputs({
          ...value.input,
          resolveProvider,
        }),
        value,
      );
      expect(resolveProvider).toHaveBeenCalledTimes(2);
      expect(resolveProvider).toHaveBeenNthCalledWith(
        2,
        value.manifest.providerBinding,
      );
    },
  );
  it("captures trusted strings/configuration/environments before any await", async () => {
    const value = await fixture();
    value.input.resolveProvider = vi.fn(() => {
      value.input.dataRoot = "/foreign/root";
      value.input.currentBuildDirectory = "/foreign/build";
      value.input.configuration.runtimeBindingsPath = "/foreign/config";
      value.input.environments.worker.CREWON_MODEL_API_KEY =
        "changed-active-key";
      return value.resolveProvider();
    });
    const result = await prepareDesktopExtensionCurrentUpgradeInputs(
      value.input,
    );
    expect(result.outcome).toBe("historyOnly");
    expect(result.environments.worker.CREWON_MODEL_API_KEY).toBe(
      "unit-current-active-key",
    );
    expect(result.environments.worker.CREWON_CONTROL_DB_PATH).toBe(
      value.databasePath,
    );
    expect(
      result.environments.worker.CREWON_EXTENSION_RUNTIME_BINDINGS_PATH,
    ).toBeUndefined();
  });
  it("propagates startup cancellation instead of downgrading it", async () => {
    const value = await fixture();
    const abort = new AbortController();
    const reason = new Error("startup canceled");
    await expect(
      prepareDesktopExtensionCurrentUpgradeInputs({
        ...value.input,
        signal: abort.signal,
        resolveProvider: () => {
          abort.abort(reason);
          return value.resolveProvider();
        },
      }),
    ).rejects.toBe(reason);
    expect(
      value.environments.worker.CREWON_EXTENSION_RUNTIME_BINDINGS_PATH,
    ).toBe(value.configuration.runtimeBindingsPath);
  });
  it("returns unchanged when optional read-only qualification exceeds its deadline", async () => {
    const value = await fixture();
    const deadline = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(deadline.signal);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    archive.resolve.mockImplementation(() => {
      entered();
      return new Promise(() => {});
    });
    const pending = prepareDesktopExtensionCurrentUpgradeInputs(value.input);
    await started;
    deadline.abort(new DOMException("timeout", "TimeoutError"));
    expectUnchanged(await pending, value);
    expect(timeout).toHaveBeenCalledWith(20_000);
    expect(value.resolveProvider).not.toHaveBeenCalled();
  });
});
