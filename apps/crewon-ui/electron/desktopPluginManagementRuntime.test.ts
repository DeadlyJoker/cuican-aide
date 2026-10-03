import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_RUNTIME_OWNER } from "./desktopExtensionRuntime.ts";
import { desktopPluginBootstrapFixture } from "./desktopPluginBootstrap.test-support.ts";
import { desktopPluginManagementFixture } from "./desktopPluginManagementRuntime.test-support.ts";
import {
  clearDesktopPluginEnvironment,
  DesktopPluginBootstrapOwner,
  desktopPluginManagementEnvironment,
} from "./desktopPluginManagementRuntime.ts";

afterEach(() => vi.unstubAllEnvs());

describe("Native-owned plugin bootstrap lifetime", () => {
  it("clears ambient grants and reuses the original artifact store without mutating the caller", () => {
    const ambient = {
      PATH: "/tools",
      CREWON_PLUGIN_UI_CONFIGURATION_PATH: "/unapproved/ui.json",
      CREWON_PLUGIN_INSTALLATION_CONFIGURATION_PATH: "/unapproved/install.json",
      CREWON_DESKTOP_PLUGIN_BOOTSTRAP_PATH: "/unapproved/bootstrap.json",
      CREWON_MODEL_API_KEY: "provider-secret",
    };
    expect(clearDesktopPluginEnvironment(ambient)).toEqual({
      PATH: ambient.PATH,
      CREWON_MODEL_API_KEY: ambient.CREWON_MODEL_API_KEY,
    });
    expect(ambient.CREWON_DESKTOP_PLUGIN_BOOTSTRAP_PATH).toBe(
      "/unapproved/bootstrap.json",
    );
    const environment = desktopPluginManagementEnvironment({
      ambient,
      dataDirectory: "/owned/desktop",
      controlPort: 4321,
      origin: "http://crewon.localhost",
      csrfToken: "native-csrf",
      sessionToken: "native-session",
    });
    expect(environment.CREWON_MODEL_API_KEY).toBeUndefined();
    expect(environment.CREWON_DESKTOP_PLUGIN_BOOTSTRAP_PATH).toBeUndefined();
    expect(environment.CREWON_CONTROL_SECURITY_MODE).toBe("standalone");
    expect(environment.CREWON_CONTROL_DB_PATH).toBe(
      "/owned/desktop/control.sqlite",
    );
    expect(environment.CREWON_ARTIFACT_DB_PATH).toBe(
      "/owned/desktop/artifact-metadata.sqlite",
    );
    expect(environment.CREWON_ARTIFACT_ENCRYPTION_KEY_ID).toBe(
      "desktop-artifact-key-v1",
    );
    expect(environment.CREWON_PRINCIPAL_ID).toBe(
      DESKTOP_RUNTIME_OWNER.principalId,
    );
    expect(environment.PATH).toBe("/tools");
  });

  it("withdraws before preparation resumes and joins cleanup of the actual late file", async () => {
    const f = desktopPluginBootstrapFixture();
    f.writeApproval();
    const owner = new DesktopPluginBootstrapOwner(f.input);
    try {
      const preparing = owner.prepared();
      owner.withdraw();
      expect(() => owner.controlEnvironment({})).toThrow(
        "desktop_plugin_bootstrap_owner_closed",
      );
      await expect(preparing).rejects.toThrow(
        "desktop_plugin_bootstrap_owner_closed",
      );
      expect(
        readdirSync(f.dataDirectory).some((name) =>
          name.startsWith("plugin-bootstrap-"),
        ),
      ).toBe(true);
      await owner.close();
      expect(
        readdirSync(f.dataDirectory).some((name) =>
          name.startsWith("plugin-bootstrap-"),
        ),
      ).toBe(false);
      expect(existsSync(join(f.dataDirectory, "plugin-profile.json"))).toBe(
        true,
      );
    } finally {
      await owner.close();
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

  it("keeps the absent opt-in free of persistent profile or installation writes", async () => {
    const f = desktopPluginBootstrapFixture(),
      owner = new DesktopPluginBootstrapOwner(f.input);
    try {
      await expect(owner.prepared()).resolves.toBeNull();
      expect(
        owner.controlEnvironment({
          CREWON_DESKTOP_PLUGIN_BOOTSTRAP_PATH: "/ambient",
        }),
      ).toEqual({});
      await owner.close();
      expect(readdirSync(f.dataDirectory)).toEqual([]);
    } finally {
      await owner.close();
      rmSync(f.directory, { recursive: true, force: true });
    }
  });
});

describe("actual managed child orchestration with explicit HTTP child fixtures", () => {
  it("retains the original no-provider/no-approval idle behavior", async () => {
    const f = desktopPluginManagementFixture({
      provider: "absent",
      approval: "absent",
    });
    try {
      await f.owner.start();
      expect(f.records()).toEqual([]);
      expect(readdirSync(f.dataDirectory)).toEqual([]);
      expect(() => f.owner.session()).toThrow("control_runtime_unavailable");
      expect(f.owner.localManagementAccess()).toBeNull();
    } finally {
      await f.close();
    }
  });

  it("starts only management Control when no provider is configured", async () => {
    vi.stubEnv("CREWON_PLUGIN_UI_CONFIGURATION_PATH", "/ambient/ui.json");
    vi.stubEnv(
      "CREWON_PLUGIN_INSTALLATION_CONFIGURATION_PATH",
      "/ambient/install.json",
    );
    vi.stubEnv(
      "CREWON_DESKTOP_PLUGIN_BOOTSTRAP_PATH",
      "/ambient/bootstrap.json",
    );
    const f = desktopPluginManagementFixture({
      provider: "absent",
      approval: "present",
    });
    const accessNotifications: ReturnType<
      typeof f.owner.localManagementAccess
    >[] = [];
    const off = f.owner.onLocalManagementAccessChanged(() => {
      accessNotifications.push(f.owner.localManagementAccess());
    });
    try {
      expect(f.owner.localManagementAccess()).toBeNull();
      await f.owner.start();
      expect(accessNotifications).toEqual([
        {
          schemaVersion: "crewon.desktop-local-management-access.v1",
          generation: f.owner.sessionGeneration,
        },
      ]);
      const [record] = f.records();
      expect(f.records().map((item) => item.kind)).toEqual(["control"]);
      expect(record.actor).toEqual(DESKTOP_RUNTIME_OWNER);
      expect(record.modelApiKey).toBeNull();
      expect(record.ambientPluginKeys).toEqual([]);
      expect(record.bootstrapPath).not.toBe("/ambient/bootstrap.json");
      expect(record.manifest?.actor).toEqual(DESKTOP_RUNTIME_OWNER);
      expect(record.agentVersionId).toMatch(
        /^desktop-plugin-management-unavailable-/,
      );
      const session = f.owner.session();
      expect(Object.keys(session).sort()).toEqual([
        "baseUrl",
        "csrfToken",
        "origin",
        "sessionToken",
      ]);
      expect(JSON.stringify(record.manifest)).not.toContain(
        session.sessionToken,
      );
      expect(
        (await fetch(new URL("api/v1/health/live", session.baseUrl))).status,
      ).toBe(200);
      expect(
        (await fetch(new URL("api/v1/health/ready", session.baseUrl))).status,
      ).toBe(503);
      const child = f.owner.currentControlOwner();
      const stopping = f.owner.stop();
      expect(f.owner.localManagementAccess()).toBeNull();
      expect(accessNotifications.at(-1)).toBeNull();
      await stopping;
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      expect(f.bootstrapFiles()).toEqual([]);
      expect(existsSync(join(f.dataDirectory, "plugin-profile.json"))).toBe(
        true,
      );
    } finally {
      off();
      await f.close();
    }
  }, 12_000);

  it("reloads explicit approval after child termination and preserves the profile", async () => {
    const f = desktopPluginManagementFixture({
      provider: "absent",
      approval: "present",
    });
    try {
      await f.owner.start();
      const first = f.records()[0],
        old = f.owner.currentControlOwner();
      const profile = readFileSync(
        join(f.dataDirectory, "plugin-profile.json"),
        "utf8",
      );
      f.writeApproval({
        ...f.approval,
        sources: [{ ...f.source, sourceId: "new-explicit-approval" }],
      });
      expect(
        JSON.parse(readFileSync(first.bootstrapPath!, "utf8")).sources[0]
          .sourceId,
      ).toBe(f.source.sourceId);
      await f.owner.restart();
      const second = f.records()[1];
      expect(old.exitCode !== null || old.signalCode !== null).toBe(true);
      expect(existsSync(first.bootstrapPath!)).toBe(false);
      expect(second.bootstrapPath).not.toBe(first.bootstrapPath);
      expect(second.manifest?.scope).toEqual(first.manifest?.scope);
      expect(second.manifest?.authorityEpoch).not.toBe(
        first.manifest?.authorityEpoch,
      );
      expect(
        readFileSync(join(f.dataDirectory, "plugin-profile.json"), "utf8"),
      ).toBe(profile);
      expect(
        (second.manifest?.sources as Array<{ sourceId: string }>)[0].sourceId,
      ).toBe("new-explicit-approval");
    } finally {
      await f.close();
    }
  }, 12_000);

  it("immediate stop cleans the actual bootstrap without launching any child", async () => {
    const f = desktopPluginManagementFixture({
      provider: "absent",
      approval: "present",
    });
    try {
      const starting = f.owner.start().catch((error: unknown) => error);
      await f.owner.stop();
      expect(await starting).toBeInstanceOf(Error);
      expect(f.records()).toEqual([]);
      expect(f.bootstrapFiles()).toEqual([]);
      expect(() => f.owner.session()).toThrow("control_runtime_unavailable");
      await f.owner.start();
      expect(f.records().map((record) => record.kind)).toEqual(["control"]);
    } finally {
      await f.close();
    }
  }, 12_000);

  it("stop joins a launched child while management readiness is pending", async () => {
    const f = desktopPluginManagementFixture({
      provider: "absent",
      approval: "present",
      controlHealth: "unavailable",
    });
    try {
      const starting = f.owner.start().catch((error: unknown) => error);
      await vi.waitFor(() => expect(f.records()).toHaveLength(1), {
        timeout: 3000,
      });
      expect(f.bootstrapFiles()).toHaveLength(1);
      await f.owner.stop();
      expect(await starting).toBeInstanceOf(Error);
      expect(f.bootstrapFiles()).toEqual([]);
      expect(() => f.owner.session()).toThrow("control_runtime_unavailable");
    } finally {
      await f.close();
    }
  }, 12_000);

  it("keeps normal release/Worker behavior and restricts the bootstrap path to Control", async () => {
    vi.stubEnv(
      "CREWON_DESKTOP_PLUGIN_BOOTSTRAP_PATH",
      "/unapproved/ambient.json",
    );
    const f = desktopPluginManagementFixture({
      provider: "configured",
      approval: "present",
    });
    try {
      await f.owner.start();
      expect(
        f
          .records()
          .map((record) => record.kind)
          .sort(),
      ).toEqual(["control", "release", "worker"]);
      const control = f.records().find((record) => record.kind === "control")!;
      const others = f.records().filter((record) => record.kind !== "control");
      expect(control.bootstrapPath).not.toBeNull();
      expect(control.bootstrapPath).not.toBe("/unapproved/ambient.json");
      expect(others.every((record) => record.bootstrapPath === null)).toBe(
        true,
      );
      expect(control.modelApiKey).toBe("fixture-model-secret");
      expect(control.artifactDb).toBe(
        join(f.dataDirectory, "artifact-metadata.sqlite"),
      );
      expect(control.artifactKey).toBe("desktop-artifact-key-v1");
      expect(f.owner.session().baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
    } finally {
      await f.close();
    }
  }, 12_000);

  it("recovers a crashed management child with a new Native generation", async () => {
    const f = desktopPluginManagementFixture({
      provider: "absent",
      approval: "present",
    });
    try {
      await f.owner.start();
      const old = f.owner.currentControlOwner(),
        first = f.records()[0];
      const generation = f.owner.sessionGeneration;
      old.kill("SIGKILL");
      await once(old, "close");
      await vi.waitFor(
        () => expect(f.owner.currentControlOwner()).not.toBe(old),
        { timeout: 5000 },
      );
      expect(f.owner.sessionGeneration).toBeGreaterThan(generation);
      expect(existsSync(first.bootstrapPath!)).toBe(false);
      expect(f.records()[1].manifest?.scope).toEqual(first.manifest?.scope);
    } finally {
      await f.close();
    }
  }, 12_000);
});
