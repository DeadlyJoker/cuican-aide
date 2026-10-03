import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { prepareAutomaticDesktopInstalledPluginRuntime } from "./desktopAutomaticInstalledPluginRuntime.ts";
import { clearDesktopInstalledPluginActivationEnvironment } from "./desktopInstalledPluginRuntime.ts";
import { assertDesktopPluginBootstrapIssued } from "./desktopPluginBootstrap.ts";
import {
  withFixture,
  type Fixture,
} from "./desktopAutomaticInstalledPluginRuntime.test-support.ts";
import {
  DESKTOP_ACTIVATABLE_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
  DESKTOP_AUTOMATIC_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
  isAutomaticDesktopInstalledPluginRuntimeConfiguration,
  loadDesktopInstalledPluginRuntimeConfiguration,
  parseDesktopInstalledPluginRuntimeConfiguration,
} from "./desktopInstalledPluginRuntimeConfiguration.ts";

const PATH = "CREWON_DESKTOP_INSTALLED_PLUGIN_ACTIVATION_CONFIG_PATH";
const PEER_TOKEN = "CREWON_DESKTOP_INSTALLED_PLUGIN_PEER_TOKEN";
const SERVICE_TOKEN = "NATIVE_ACTIVATION_AUTHORITY_TOKEN";
const secret = "native-activation-policy-service-token-0000000000000000";
const authority = {
  url: "https://activation.example/current",
  serviceTokenEnvironmentVariable: SERVICE_TOKEN,
};
const activationDirectories = (f: Fixture) =>
  readdirSync(f.dataDirectory).filter((name) =>
    name.startsWith(".installed-plugin-activation-"),
  );

function configuration(f: Fixture) {
  f.write({
    ...f.value,
    schemaVersion: DESKTOP_ACTIVATABLE_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
    activationAuthority: authority,
  });
  const loaded = loadDesktopInstalledPluginRuntimeConfiguration(
    f.dataDirectory,
  );
  if (
    !loaded.enabled ||
    !isAutomaticDesktopInstalledPluginRuntimeConfiguration(loaded)
  )
    throw new Error("fixture v3 configuration");
  return loaded;
}
function prepare(f: Fixture) {
  return prepareAutomaticDesktopInstalledPluginRuntime({
    ...f.input,
    configuration: configuration(f),
    sharedEnvironment: {
      ...f.input.sharedEnvironment,
      [SERVICE_TOKEN]: secret,
    },
    workerEnvironment: {
      ...f.input.workerEnvironment,
      [SERVICE_TOKEN]: secret,
    },
  });
}

describe("explicit Native v3 activation input ownership", () => {
  it("clears inherited bridge paths and peer secrets while preserving existing worker service references", () => {
    expect(
      clearDesktopInstalledPluginActivationEnvironment({
        [PATH]: "/inherited/activation.json",
        [PEER_TOKEN]: "inherited-peer-secret",
        CREWON_INSTALLED_PLUGIN_AUTHORITY_POLICY:
          "existing-authority-reference",
        ORIGINAL: "kept",
      }),
    ).toEqual({
      CREWON_INSTALLED_PLUGIN_AUTHORITY_POLICY: "existing-authority-reference",
      ORIGINAL: "kept",
    });
  });
  it("accepts exact disabled v3 and keeps v2 without activation authority", async () => {
    await withFixture(async (f) => {
      expect(
        parseDesktopInstalledPluginRuntimeConfiguration({
          schemaVersion: DESKTOP_ACTIVATABLE_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
          enabled: false,
        }),
      ).toEqual({
        schemaVersion: DESKTOP_ACTIVATABLE_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
        enabled: false,
      });
      expect(() =>
        parseDesktopInstalledPluginRuntimeConfiguration({
          ...f.value,
          activationAuthority: authority,
        }),
      ).toThrow();
      expect(() =>
        parseDesktopInstalledPluginRuntimeConfiguration({
          ...f.value,
          schemaVersion: DESKTOP_ACTIVATABLE_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
        }),
      ).toThrow();
      expect(() =>
        parseDesktopInstalledPluginRuntimeConfiguration({
          schemaVersion: DESKTOP_ACTIVATABLE_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
          enabled: false,
          activationAuthority: authority,
        }),
      ).toThrow();
      const old = f.prepare();
      try {
        f.output(old);
        const completed = old.complete();
        if (completed.kind !== "installed")
          throw new Error("fixture installed");
        expect(
          completed.runtime.controlAfterPeer({
            origin: "http://127.0.0.1:40123",
          }),
        ).toEqual(completed.runtime.control);
        expect(activationDirectories(f)).toEqual([]);
        expect(f.configuration().schemaVersion).toBe(
          DESKTOP_AUTOMATIC_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
        );
      } finally {
        await old.close();
      }
    });
  });

  it.each([
    { url: "http://activation.example/current" },
    { url: "https://activation.example/current?token=bad" },
    { url: "https://user@activation.example/current" },
    { serviceTokenEnvironmentVariable: "CREWON_CONTROL_SESSION_TOKEN" },
    {
      serviceTokenEnvironmentVariable:
        "CREWON_DESKTOP_INSTALLED_PLUGIN_PEER_TOKEN",
    },
    { serviceTokenEnvironmentVariable: "NODE_OPTIONS" },
    { serviceTokenEnvironmentVariable: "HOME" },
    { walletId: "not-a-grant" },
  ])("refuses ambiguous activation authority %j", async (overrides) => {
    await withFixture(async (f) => {
      expect(() =>
        parseDesktopInstalledPluginRuntimeConfiguration({
          ...f.value,
          schemaVersion: DESKTOP_ACTIVATABLE_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
          activationAuthority: { ...authority, ...overrides },
        }),
      ).toThrow();
      expect(activationDirectories(f)).toEqual([]);
    });
  });

  it("captures all actual published entries only after the challenge and sends policy/peer credentials only to Control", async () => {
    await withFixture(async (f) => {
      const owner = prepare(f);
      try {
        expect(owner.preparationEnvironment[SERVICE_TOKEN]).toBeUndefined();
        expect(owner.preparationEnvironment[PATH]).toBeUndefined();
        expect(activationDirectories(f)).toEqual([]);
        f.output(owner);
        const completed = owner.complete();
        if (completed.kind !== "installed")
          throw new Error("fixture installed");
        const runtime = completed.runtime;
        expect(runtime.control[SERVICE_TOKEN]).toBeUndefined();
        expect(runtime.control[PATH]).toBeUndefined();
        expect(runtime.worker[SERVICE_TOKEN]).toBeUndefined();
        expect(runtime.release[SERVICE_TOKEN]).toBeUndefined();
        const control = runtime.controlAfterPeer({
          origin: "http://127.0.0.1:40123",
        });
        expect(control[SERVICE_TOKEN]).toBe(secret);
        expect(control[PEER_TOKEN]).toBe(runtime.token);
        expect(control.CREWON_INSTALLED_PLUGIN_PEER_TOKEN).toBeUndefined();
        expect(
          control.CREWON_INSTALLED_PLUGIN_EXECUTION_CONFIG_PATH,
        ).toBeUndefined();
        expect(
          control.CREWON_INSTALLED_PLUGIN_TASK_CONFIG_PATH,
        ).toBeUndefined();
        const path = control[PATH]!;
        expect(dirname(dirname(path))).toBe(f.dataDirectory);
        expect(lstatSync(dirname(path)).mode & 0o777).toBe(0o700);
        expect(lstatSync(path).mode & 0o777).toBe(0o600);
        expect(lstatSync(path).nlink).toBe(1);
        const document = JSON.parse(readFileSync(path, "utf8"));
        const manifest = assertDesktopPluginBootstrapIssued(f.bootstrap);
        expect(document).toEqual({
          schemaVersion: "crewon.desktop-installed-plugin-activation.v1",
          actor: manifest.actor,
          scope: f.bootstrap.scope,
          installRoot: manifest.installRoot,
          peer: {
            origin: "http://127.0.0.1:40123",
            tokenEnvironmentVariable: PEER_TOKEN,
          },
          authority,
          timeoutMs: 20_000,
          entries: runtime.expectedCatalogEntries.map(
            ({ identity, configuration, configuredTarget }) => ({
              identity,
              configuration,
              target: configuredTarget,
            }),
          ),
        });
        expect(readFileSync(path, "utf8")).not.toContain(secret);
        expect(readFileSync(path, "utf8")).not.toContain(runtime.token);
        expect(JSON.stringify(owner)).not.toContain(secret);
        expect(JSON.stringify(runtime)).not.toContain(secret);
        expect(inspect(runtime)).not.toContain(secret);
        expect(
          runtime.controlAfterPeer({ origin: "http://127.0.0.1:40123" })[PATH],
        ).toBe(path);
        expect(() =>
          runtime.controlAfterPeer({ origin: "http://127.0.0.1:40124" }),
        ).toThrow("activation_peer_changed");
        expect(activationDirectories(f)).toHaveLength(1);
        runtime.withdraw();
        expect(() =>
          runtime.controlAfterPeer({ origin: "http://127.0.0.1:40123" }),
        ).toThrow("withdrawn");
        expect(readFileSync(path, "utf8")).toBeTruthy();
      } finally {
        await owner.close();
      }
      expect(activationDirectories(f)).toEqual([]);
    });
  });

  it("revokes captured inputs when the fixed v3 source file is replaced while retiring unchanged owned activation files", async () => {
    await withFixture(async (f) => {
      const owner = prepare(f);
      try {
        f.output(owner);
        const completed = owner.complete();
        if (completed.kind !== "installed")
          throw new Error("fixture installed");
        const runtime = completed.runtime;
        runtime.controlAfterPeer({
          origin: "http://127.0.0.1:40123",
        });
        const path = f.configurationPath;
        const replacement = join(dirname(path), "replacement.json");
        writeFileSync(replacement, readFileSync(path), {
          flag: "wx",
          mode: 0o600,
        });
        renameSync(replacement, path);
        expect(() => runtime.assertCurrent()).toThrow("file_changed");
        expect(() =>
          runtime.controlAfterPeer({ origin: "http://127.0.0.1:40123" }),
        ).toThrow("file_changed");
      } finally {
        await owner.close();
      }
      expect(activationDirectories(f)).toEqual([]);
    });
  });

  it.each(["replaced", "modified", "unknownChild"] as const)(
    "refuses activation cleanup and retains actual filesystem contents after %s",
    async (kind) => {
      await withFixture(async (f) => {
        const owner = prepare(f);
        let changed = false;
        try {
          f.output(owner);
          const completed = owner.complete();
          if (completed.kind !== "installed")
            throw new Error("fixture installed");
          const runtime = completed.runtime;
          const path = runtime.controlAfterPeer({
            origin: "http://127.0.0.1:40123",
          })[PATH]!;
          const directory = dirname(path);
          const original = readFileSync(path);
          let retainedPath = path;
          if (kind === "replaced") {
            const replacement = join(directory, "replacement.json");
            writeFileSync(replacement, original, { flag: "wx", mode: 0o600 });
            renameSync(replacement, path);
          } else if (kind === "modified") {
            writeFileSync(path, "modified-grant-must-survive", { mode: 0o600 });
          } else {
            retainedPath = join(directory, "unknown-child.txt");
            writeFileSync(retainedPath, "unknown-child-must-survive", {
              flag: "wx",
              mode: 0o600,
            });
          }
          changed = true;
          const retainedBytes = readFileSync(retainedPath),
            retainedStat = lstatSync(retainedPath);
          await expect(owner.close()).rejects.toThrow(
            kind === "unknownChild"
              ? "activation_directory_contents_changed"
              : "file_changed",
          );
          expect(readFileSync(retainedPath)).toEqual(retainedBytes);
          expect(lstatSync(retainedPath).ino).toBe(retainedStat.ino);
          expect(lstatSync(retainedPath).mtimeMs).toBe(retainedStat.mtimeMs);
          expect(activationDirectories(f)).toHaveLength(1);
          if (kind === "unknownChild")
            expect(readFileSync(path)).toEqual(original);
          expect(() =>
            runtime.controlAfterPeer({ origin: "http://127.0.0.1:40123" }),
          ).toThrow("withdrawn");
        } finally {
          // The fixture owns these mutations and has no consuming processes. Product cleanup
          // must leave them intact; withFixture retires its complete private test root afterward.
          if (!changed) await owner.close();
        }
      });
    },
  );

  it("keeps all-blocked default environments without activation files or credentials", async () => {
    await withFixture(async (f) => {
      const owner = prepare(f);
      try {
        f.writeResult(owner, [
          {
            pluginId: f.source.pluginId,
            state: "blocked",
            reasonCode: "configurationMissing",
          },
        ]);
        const completed = owner.complete();
        if (completed.kind !== "default") throw new Error("fixture default");
        for (const environment of [
          completed.environments.sharedEnvironment,
          completed.environments.workerEnvironment,
        ]) {
          expect(environment[SERVICE_TOKEN]).toBeUndefined();
          expect(environment[PATH]).toBeUndefined();
          expect(environment[PEER_TOKEN]).toBeUndefined();
        }
        expect(activationDirectories(f)).toEqual([]);
      } finally {
        await owner.close();
      }
    });
  });

  it("requires an actual captured activation service token before creating any private file", async () => {
    await withFixture(async (f) => {
      expect(() =>
        prepareAutomaticDesktopInstalledPluginRuntime({
          ...f.input,
          configuration: configuration(f),
        }),
      ).toThrow("authority_token");
      expect(activationDirectories(f)).toEqual([]);
    });
  });

  it("refuses cleanup of a replaced activation directory and retains the replacement until the original owned inode returns", async () => {
    await withFixture(async (f) => {
      const owner = prepare(f);
      let restore: (() => void) | undefined;
      try {
        f.output(owner);
        const completed = owner.complete();
        if (completed.kind !== "installed")
          throw new Error("fixture installed");
        const runtime = completed.runtime;
        const path = runtime.controlAfterPeer({
          origin: "http://127.0.0.1:40123",
        })[PATH]!;
        const directory = dirname(path),
          retired = `${directory}.retained`;
        renameSync(directory, retired);
        mkdirSync(directory, { mode: 0o700 });
        writeFileSync(path, "replacement-directory-must-survive", {
          flag: "wx",
          mode: 0o600,
        });
        restore = () => {
          rmSync(directory, { recursive: true });
          renameSync(retired, directory);
        };
        expect(() => runtime.assertCurrent()).toThrow(
          "activation_directory_changed",
        );
        await expect(runtime.close()).rejects.toThrow(
          "activation_directory_changed",
        );
        expect(readFileSync(path, "utf8")).toBe(
          "replacement-directory-must-survive",
        );
      } finally {
        restore?.();
        await owner.close();
      }
      expect(activationDirectories(f)).toEqual([]);
    });
  });
});
