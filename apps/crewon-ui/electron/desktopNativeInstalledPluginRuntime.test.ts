import {
  writeFileSync,
  readFileSync,
  readdirSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { desktopInstalledPluginRuntimeFixture } from "./desktopInstalledPluginRuntime.test-support.ts";
import { prepareNativeDesktopInstalledPluginRuntime } from "./desktopNativeInstalledPluginRuntime.ts";
import { DESKTOP_NATIVE_PLUGIN_POLICY_FILE } from "./desktopNativePluginAuthority.ts";

async function fixture() {
  const f = await desktopInstalledPluginRuntimeFixture();
  const policyPath = join(f.dataDirectory, DESKTOP_NATIVE_PLUGIN_POLICY_FILE);
  const policy = {
    schemaVersion: "crewon.desktop-native-plugin-policy.v1",
    packages: [
      {
        pluginId: f.source.pluginId,
        publisherId: f.source.publisherId,
        version: f.source.version,
        packageDigest: f.source.packageDigest,
        approvalRequirement: "none",
      },
    ],
    networkGrants: [],
  };
  const prepare = () => prepareNativeDesktopInstalledPluginRuntime(f.input);
  const writePolicy = (value: unknown = policy) =>
    writeFileSync(policyPath, JSON.stringify(value), { mode: 0o600 });
  const paths = (owner: NonNullable<ReturnType<typeof prepare>>) => {
    const path =
      owner.preparationEnvironment
        .CREWON_INSTALLED_PLUGIN_NATIVE_PREPARATION_PATH!;
    const directory = dirname(path);
    return {
      directory,
      release: join(directory, "release.json"),
      result: join(directory, "preparation-result.json"),
      worker: join(directory, "worker.json"),
    };
  };
  function result(
    owner: NonNullable<ReturnType<typeof prepare>>,
    prepared: boolean,
  ) {
    const p = paths(owner),
      entry = f.release.entries[0]!;
    if (prepared)
      writeFileSync(p.release, JSON.stringify(f.release), {
        mode: 0o600,
        flag: "wx",
      });
    writeFileSync(
      p.result,
      JSON.stringify({
        schemaVersion: "crewon.installed-plugin-native-preparation-result.v1",
        actor: f.input.bootstrap
          ? JSON.parse(readFileSync(f.bootstrap.bootstrapPath, "utf8")).actor
          : undefined,
        scope: f.bootstrap.scope,
        defaultAgentVersionId: f.release.defaultAgentVersionId,
        plugins: prepared
          ? [
              {
                pluginId: f.source.pluginId,
                state: "prepared",
                packageIdentity: entry.packageIdentity,
                configuration: {
                  revision: entry.configuration.revision,
                  contentDigest: entry.configuration.contentDigest,
                },
                approvalRequirement: "none",
                target: entry.target,
              },
            ]
          : [
              {
                pluginId: f.source.pluginId,
                state: "blocked",
                reasonCode: "notInstalled",
              },
            ],
      }),
      { mode: 0o600, flag: "wx" },
    );
    return p;
  }
  return {
    ...f,
    async close() {
      await f.bootstrap.cleanup();
      rmSync(f.directory, { recursive: true, force: true });
    },
    policyPath,
    policy,
    prepare,
    writePolicy,
    paths,
    result,
  };
}

describe("explicit Main Native installed plugin execution", () => {
  it("absent policy leaves default Agent and management unchanged", async () => {
    const f = await fixture();
    try {
      const before = readdirSync(f.dataDirectory);
      expect(f.prepare()).toBeNull();
      expect(readdirSync(f.dataDirectory)).toEqual(before);
    } finally {
      await f.close();
    }
  });
  it("refuses unapproved tuples and nonprivate policy before publishing authority", async () => {
    const f = await fixture();
    try {
      f.writePolicy({
        ...f.policy,
        packages: [
          {
            ...f.policy.packages[0],
            packageDigest: `sha256:${"f".repeat(64)}`,
          },
        ],
      });
      expect(() => f.prepare()).toThrow("native_package_unapproved");
      f.writePolicy();
      chmodSync(f.policyPath, 0o644);
      expect(() => f.prepare()).toThrow();
      expect(
        readdirSync(f.dataDirectory).some((name) =>
          name.startsWith(".native-plugin-authority-"),
        ),
      ).toBe(false);
    } finally {
      await f.close();
    }
  });
  it("not yet installed falls back without supplying execution or bypassing default Agent", async () => {
    const f = await fixture();
    let owner: ReturnType<typeof f.prepare> = null;
    try {
      f.writePolicy();
      owner = f.prepare()!;
      f.result(owner, false);
      const completed = owner.complete();
      expect(completed.kind).toBe("default");
      if (completed.kind !== "default") throw new Error("expected fallback");
      expect(
        completed.environments.sharedEnvironment
          .CREWON_INSTALLED_PLUGIN_EXECUTION_CONFIG_PATH,
      ).toBeUndefined();
      expect(
        completed.environments.workerEnvironment.CREWON_MODEL_API_KEY,
      ).toBe(f.input.workerEnvironment.CREWON_MODEL_API_KEY);
      await owner.close();
      expect(
        readdirSync(f.dataDirectory).some((name) =>
          name.startsWith(".native-plugin-authority-"),
        ),
      ).toBe(false);
    } finally {
      await owner?.close();
      await f.close();
    }
  });
  it("uses an actual pinned release and publishes Control access only after the real peer challenge", async () => {
    const f = await fixture();
    let owner: ReturnType<typeof f.prepare> = null;
    try {
      f.writePolicy();
      owner = f.prepare()!;
      const p = f.result(owner, true);
      const config = JSON.parse(readFileSync(p.worker, "utf8"));
      expect(config.schemaVersion).toBe(
        "crewon.installed-plugin-native-worker.v1",
      );
      expect(config.actorAuthority).toBeUndefined();
      const completed = owner.complete();
      expect(completed.kind).toBe("installed");
      if (completed.kind !== "installed") throw new Error("expected installed");
      const runtime = completed.runtime;
      expect(
        runtime.control.CREWON_DESKTOP_NATIVE_PLUGIN_CONTROL_PATH,
      ).toBeUndefined();
      expect(() =>
        runtime.controlAfterPeer({ origin: "https://unapproved.example" }),
      ).toThrow();
      const env = runtime.controlAfterPeer({
        origin: "http://127.0.0.1:39431",
      });
      const control = JSON.parse(
        readFileSync(env.CREWON_DESKTOP_NATIVE_PLUGIN_CONTROL_PATH!, "utf8"),
      );
      expect(control.entries).toEqual(runtime.expectedCatalogEntries);
      expect(control.authorityPath).toBe(config.nativeAuthorityPath);
      expect(() =>
        runtime.controlAfterPeer({ origin: "http://127.0.0.1:39432" }),
      ).toThrow("native_peer_changed");
      owner.withdraw();
      expect(() => runtime.worker).toThrow("withdrawn");
      await owner.close();
    } finally {
      await owner?.close();
      await f.close();
    }
  });
  it("revokes a running owner when the actual host approval or private policy changes", async () => {
    const f = await fixture();
    let owner: ReturnType<typeof f.prepare> = null;
    try {
      f.writePolicy();
      owner = f.prepare()!;
      f.writePolicy({ ...f.policy, networkGrants: [] });
      expect(() => owner!.assertCurrent()).toThrow("file_changed");
    } finally {
      try {
        await owner?.close();
      } catch {}
      await f.close();
    }
  });
});
