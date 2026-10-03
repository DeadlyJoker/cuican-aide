import { readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { prepareAutomaticDesktopInstalledPluginRuntime } from "./desktopAutomaticInstalledPluginRuntime.ts";
import { DESKTOP_AUTOMATIC_INSTALLED_PLUGIN_RUNTIME_SCHEMA } from "./desktopInstalledPluginRuntimeConfiguration.ts";
import { DESKTOP_RUNTIME_OWNER } from "./desktopExtensionRuntime.ts";
import { prepareDesktopPluginBootstrap } from "./desktopPluginBootstrap.ts";
import {
  directories,
  withFixture,
} from "./desktopAutomaticInstalledPluginRuntime.test-support.ts";

describe("Native per-plugin preparation isolation", () => {
  it("preserves the prepared subset when another requested plugin is unapproved", async () => {
    await withFixture(async (f) => {
      f.value.plugins.push({
        pluginId: "other.plugin",
        approvalRequirement: "none",
      });
      f.write();
      const owner = f.prepare();
      const p = f.output(owner);
      expect(f.read(p.preparationPath).plugins).toEqual(f.value.plugins);
      const completed = owner.complete();
      if (completed.kind !== "installed")
        throw new Error("fixture prepared subset");
      expect(completed.runtime.expectedCatalogEntries).toHaveLength(1);
      expect(completed.statuses).toEqual(f.statuses());
      expect(completed.statuses[1]).toEqual({
        pluginId: "other.plugin",
        state: "blocked",
        reasonCode: "notApproved",
      });
      expect(JSON.stringify(completed)).not.toContain(f.provider.apiKey);
      expect(
        Object.keys(completed.runtime.control).some((name) =>
          name.startsWith("CREWON_INSTALLED_PLUGIN_"),
        ),
      ).toBe(false);
      await owner.close();
      expect(directories(f)).toEqual([]);
    });
  });
  it.each([
    "notInstalled",
    "notApproved",
    "configurationMissing",
    "configurationIncompatible",
    "packageUnavailable",
    "readDenied",
    "stateChanged",
  ] as const)(
    "retains original default environments for an entirely blocked %s result",
    async (reasonCode) => {
      await withFixture(async (f) => {
        f.input.sharedEnvironment.CREWON_MODEL_API_KEY = f.provider.apiKey;
        const owner = f.prepare();
        const p = f.writeResult(owner, [
          { pluginId: f.source.pluginId, state: "blocked", reasonCode },
        ]);
        const completed = owner.complete();
        if (completed.kind !== "default")
          throw new Error("fixture default completion");
        expect(owner.complete()).toBe(completed);
        for (const environment of [
          completed.environments.sharedEnvironment,
          completed.environments.workerEnvironment,
        ]) {
          expect(environment.CREWON_AGENT_VERSION_ID).toBe(
            f.release.defaultAgentVersionId,
          );
          expect(environment.CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH).toBe(
            f.input.sharedEnvironment
              .CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH,
          );
          expect(environment.CREWON_MODEL_ID).toBe(f.provider.modelId);
          expect(environment.CREWON_MODEL_API_KEY).toBe(f.provider.apiKey);
          expect(environment.CREWON_CONTROL_SESSION_TOKEN).toBe(
            f.input.sharedEnvironment.CREWON_CONTROL_SESSION_TOKEN,
          );
          expect(environment.NATIVE_INSTALLED_AUTHORITY_TOKEN).toBeUndefined();
          expect(
            Object.keys(environment).some((name) =>
              name.startsWith("CREWON_INSTALLED_PLUGIN_"),
            ),
          ).toBe(false);
          expect(Object.isFrozen(environment)).toBe(true);
        }
        expect(completed.statuses).toEqual([
          { pluginId: f.source.pluginId, state: "blocked", reasonCode },
        ]);
        expect(JSON.stringify(completed)).not.toContain(f.provider.apiKey);
        expect(readdirSync(p.directory)).toEqual([
          "preparation-result.json",
          "preparation.json",
          "worker.json",
        ]);
        owner.withdraw();
        expect(() => completed.environments).toThrow("withdrawn");
        expect(readdirSync(p.directory)).toHaveLength(3);
        await owner.close();
        expect(directories(f)).toEqual([]);
        expect(readFileSync(f.configurationPath, "utf8")).toContain(
          DESKTOP_AUTOMATIC_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
        );
      });
    },
  );
  it("allows a real empty approval set to produce blocked metadata without issuing an installed runtime", async () => {
    await withFixture(async (f) => {
      await f.bootstrap.cleanup();
      f.writeApproval({ ...f.approval, sources: [], publications: [] });
      const bootstrap = (await prepareDesktopPluginBootstrap({
        dataDirectory: f.dataDirectory,
        actor: DESKTOP_RUNTIME_OWNER,
        sessionEntropy: "actual-unit-session-empty-approval",
      }))!;
      const owner = prepareAutomaticDesktopInstalledPluginRuntime({
        ...f.input,
        bootstrap,
        configuration: f.configuration(),
      });
      try {
        const p = f.writeResult(owner, [
          {
            pluginId: f.source.pluginId,
            state: "blocked",
            reasonCode: "notApproved",
          },
        ]);
        expect(f.read(p.preparationPath).approvedPackages).toEqual([]);
        expect(owner.complete().kind).toBe("default");
      } finally {
        await owner.close();
        await bootstrap.cleanup();
      }
    });
  });
  it("does not allow an unapproved prepared result to issue an installed runtime", async () => {
    await withFixture(async (f) => {
      await f.bootstrap.cleanup();
      f.writeApproval({ ...f.approval, sources: [], publications: [] });
      const bootstrap = (await prepareDesktopPluginBootstrap({
        dataDirectory: f.dataDirectory,
        actor: DESKTOP_RUNTIME_OWNER,
        sessionEntropy: "actual-unit-session-unapproved-output",
      }))!;
      const owner = prepareAutomaticDesktopInstalledPluginRuntime({
        ...f.input,
        bootstrap,
        configuration: f.configuration(),
      });
      try {
        f.output(owner);
        expect(() => owner.complete()).toThrow();
        expect(() => owner.preparationEnvironment).toThrow("withdrawn");
      } finally {
        await owner.close();
        await bootstrap.cleanup();
      }
    });
  });
  it.each(["provider", "result-inode", "late-release"])(
    "keeps default completion owned when %s changes",
    async (kind) => {
      await withFixture(async (f) => {
        const owner = f.prepare();
        const p = f.writeResult(owner, [
          {
            pluginId: f.source.pluginId,
            state: "blocked",
            reasonCode: "configurationMissing",
          },
        ]);
        const completed = owner.complete();
        if (completed.kind !== "default")
          throw new Error("fixture default completion");
        if (kind === "provider") f.provider.modelId = "changed-model";
        if (kind === "result-inode") {
          writeFileSync(
            `${p.resultPath}.replacement`,
            readFileSync(p.resultPath),
            { flag: "wx", mode: 0o600 },
          );
          renameSync(`${p.resultPath}.replacement`, p.resultPath);
        }
        if (kind === "late-release")
          writeFileSync(p.releasePath, JSON.stringify(f.release), {
            flag: "wx",
            mode: 0o600,
          });
        expect(() => completed.environments).toThrow();
        await owner.close();
        expect(directories(f)).toEqual([]);
      });
    },
  );
  it.each(["unexpected-release", "result-drift"])(
    "fails closed on blocked output %s",
    async (kind) => {
      await withFixture(async (f) => {
        const owner = f.prepare();
        const p = f.writeResult(owner, [
          {
            pluginId: f.source.pluginId,
            state: "blocked",
            reasonCode: "readDenied",
          },
        ]);
        if (kind === "unexpected-release")
          writeFileSync(p.releasePath, JSON.stringify(f.release), {
            flag: "wx",
            mode: 0o600,
          });
        else {
          owner.complete();
          writeFileSync(p.resultPath, readFileSync(p.resultPath, "utf8") + " ");
        }
        expect(() => owner.complete()).toThrow();
        await owner.close();
        expect(directories(f)).toEqual([]);
      });
    },
  );
  it.each([
    "actor",
    "scope",
    "default",
    "missing-plugin",
    "configuration",
    "target",
    "package",
  ])(
    "rejects preparation result %s that does not match the actual input/release",
    async (kind) => {
      await withFixture(async (f) => {
        const owner = f.prepare();
        const p = f.paths(owner);
        writeFileSync(p.releasePath, JSON.stringify(f.release), {
          flag: "wx",
          mode: 0o600,
        });
        const [status] = f.statuses();
        if (!status || status.state !== "prepared")
          throw new Error("fixture prepared status");
        let plugins: unknown = [status];
        const overrides: Record<string, unknown> = {};
        if (kind === "actor")
          overrides.actor = {
            ...DESKTOP_RUNTIME_OWNER,
            actorId: "another-actor",
          };
        if (kind === "scope")
          overrides.scope = {
            ...f.bootstrap.scope,
            profileId: "another-profile",
          };
        if (kind === "default")
          overrides.defaultAgentVersionId = "another-default";
        if (kind === "missing-plugin")
          plugins = [
            {
              pluginId: "another.plugin",
              state: "blocked",
              reasonCode: "notInstalled",
            },
          ];
        if (kind === "configuration")
          plugins = [
            {
              ...status,
              configuration: { ...status.configuration, revision: 2 },
            },
          ];
        if (kind === "target")
          plugins = [
            {
              ...status,
              target: { ...status.target, policySnapshotId: "another-policy" },
            },
          ];
        if (kind === "package")
          plugins = [
            {
              ...status,
              packageIdentity: {
                ...status.packageIdentity,
                packageDigest: `sha256:${"f".repeat(64)}`,
              },
            },
          ];
        f.writeResult(owner, plugins, overrides);
        expect(() => owner.complete()).toThrow();
        expect(() => owner.preparationEnvironment).toThrow("withdrawn");
      });
    },
  );
});
