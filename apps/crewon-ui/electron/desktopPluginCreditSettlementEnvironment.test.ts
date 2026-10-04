import { chmodSync, linkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as documentCapture from "./desktopInstalledPluginRuntimeConfiguration.ts";
import {
  captureDesktopPluginCreditSettlementEnvironment,
  DESKTOP_PLUGIN_CREDIT_SETTLEMENT_CONFIG_ENV,
  desktopPluginCreditSettlementSharedEnvironment,
} from "./desktopPluginCreditSettlementEnvironment.ts";
import { desktopFinancialEnvironmentFixture } from "./desktopPluginCreditSettlementEnvironment.test-support.ts";

describe("Native financial environment isolation", () => {
  it("has no file reads or guessed token removal without opt-in", () => {
    const capture = vi.spyOn(
      documentCapture,
      "captureDesktopInstalledPluginRuntimeDocument",
    );
    const ambient = {
      PATH: "/tools",
      CREWON_FINANCIAL_AUTHORIZATION_TOKEN: "unchanged-without-declaration",
    };
    const owner = captureDesktopPluginCreditSettlementEnvironment(ambient);
    try {
      expect(owner.project(ambient, { role: "shared" })).toEqual(ambient);
      expect(owner.project(ambient, { role: "worker" })).toEqual(ambient);
      owner.assertCurrent();
      expect(capture).not.toHaveBeenCalled();
      expect(() =>
        owner.project(
          {
            ...ambient,
            [DESKTOP_PLUGIN_CREDIT_SETTLEMENT_CONFIG_ENV]: "/late/unowned.json",
          },
          { role: "worker" },
        ),
      ).toThrow("overlay_conflict");
      expect(capture).not.toHaveBeenCalled();
    } finally {
      owner.close();
      capture.mockRestore();
    }
  });

  it("removes only declared refs from shared/preparation/release/control and restores exact captured values only for Worker", () => {
    const f = desktopFinancialEnvironmentFixture();
    const owner = captureDesktopPluginCreditSettlementEnvironment(
      f.environment,
    );
    const original = { ...f.environment };
    try {
      const shared = owner.project(f.environment, { role: "shared" });
      expect(
        shared[DESKTOP_PLUGIN_CREDIT_SETTLEMENT_CONFIG_ENV],
      ).toBeUndefined();
      expect(shared[f.authorizationName]).toBeUndefined();
      expect(shared[f.decisionName]).toBeUndefined();
      expect(shared.CREWON_FINANCIAL_UNDECLARED_TOKEN).toBe(
        f.environment.CREWON_FINANCIAL_UNDECLARED_TOKEN,
      );
      expect(shared.CREWON_MODEL_API_KEY).toBe(
        f.environment.CREWON_MODEL_API_KEY,
      );
      for (const role of [
        "preparation",
        "release",
        "control",
        "catalogue",
        "historical-worker",
      ]) {
        const overlaid = {
          ...shared,
          ...f.environment,
          ORIGINAL_LAUNCH_ROLE: role,
        };
        const projected = owner.project(overlaid, { role: "shared" });
        expect(
          projected[DESKTOP_PLUGIN_CREDIT_SETTLEMENT_CONFIG_ENV],
        ).toBeUndefined();
        expect(projected[f.authorizationName]).toBeUndefined();
        expect(projected[f.decisionName]).toBeUndefined();
        expect(projected.ORIGINAL_LAUNCH_ROLE).toBe(role);
      }
      const worker = owner.project(
        { ...shared, CREWON_MODEL_ID: "original-model-overlay" },
        { role: "worker" },
      );
      expect(worker[DESKTOP_PLUGIN_CREDIT_SETTLEMENT_CONFIG_ENV]).toBe(f.path);
      expect(worker[f.authorizationName]).toBe(f.authorizationToken);
      expect(worker[f.decisionName]).toBe(f.decisionToken);
      expect(worker.CREWON_MODEL_ID).toBe("original-model-overlay");
      expect(f.environment).toEqual(original);
      expect(JSON.stringify(owner)).not.toContain(f.authorizationToken);
      expect(Object.isFrozen(owner)).toBe(true);
    } finally {
      owner.close();
      f.cleanup();
    }
  });

  it("rejects conflicting final overlays and keeps the original caller untouched", () => {
    const f = desktopFinancialEnvironmentFixture();
    try {
      for (const name of [
        DESKTOP_PLUGIN_CREDIT_SETTLEMENT_CONFIG_ENV,
        f.authorizationName,
        f.decisionName,
      ]) {
        const input = { ...f.environment, [name]: "another-overlay-value" };
        for (const role of ["shared", "worker"] as const) {
          const owner = captureDesktopPluginCreditSettlementEnvironment(
            f.environment,
          );
          try {
            expect(() => owner.project(input, { role })).toThrow(
              "overlay_conflict",
            );
            expect(() =>
              owner.project(f.environment, { role: "worker" }),
            ).toThrow("withdrawn");
          } finally {
            owner.close();
          }
        }
        expect(input[name]).toBe("another-overlay-value");
      }
      const owner = captureDesktopPluginCreditSettlementEnvironment(
        f.environment,
      );
      owner.close();
      expect(() => owner.project(f.environment, { role: "worker" })).toThrow(
        "closed",
      );
    } finally {
      f.cleanup();
    }
  });

  it("uses immutable captured credentials for scrubbed Worker input rather than watching ambient changes", () => {
    const f = desktopFinancialEnvironmentFixture();
    const ambient = { ...f.environment };
    const owner = captureDesktopPluginCreditSettlementEnvironment(ambient);
    try {
      const scrubbed = owner.project(ambient, { role: "shared" });
      ambient[f.authorizationName] =
        "later-main-environment-token-not-recaptured";
      const worker = owner.project(scrubbed, { role: "worker" });
      expect(worker[f.authorizationName]).toBe(f.authorizationToken);
      expect(() => owner.project(ambient, { role: "worker" })).toThrow(
        "overlay_conflict",
      );
      expect(() => owner.project(scrubbed, { role: "worker" })).toThrow(
        "withdrawn",
      );
    } finally {
      owner.close();
      f.cleanup();
    }
  });

  it("permanently withdraws a capture when the bound original file changes", () => {
    const f = desktopFinancialEnvironmentFixture();
    const owner = captureDesktopPluginCreditSettlementEnvironment(
      f.environment,
    );
    try {
      f.write({
        ...f.document,
        decisionAuthority: {
          url: "https://financial.example/decide",
          serviceTokenEnvironmentVariable: "ANOTHER_TOKEN_REFERENCE",
        },
      });
      expect(() => owner.project(f.environment, { role: "shared" })).toThrow(
        "file_changed",
      );
      f.write();
      expect(() => owner.project(f.environment, { role: "worker" })).toThrow(
        "withdrawn",
      );
      expect(() => owner.assertCurrent()).toThrow("withdrawn");
    } finally {
      owner.close();
      f.cleanup();
    }
  });

  it.each([
    "PATH",
    "HOME",
    "SHELL",
    "TERM",
    "USER",
    "NODE_OPTIONS",
    "NODE_EXTRA_CA_CERTS",
    "ELECTRON_RUN_AS_NODE",
    "CREWON_MODEL_API_KEY",
    "CREWON_CONTROL_SESSION_TOKEN",
    "CREWON_PLUGIN_CREDIT_SETTLEMENT_CONFIG_PATH",
    "CREWON_INSTALLED_PLUGIN_AUTHORITY_TOKEN",
    "HTTPS_PROXY",
    "SYSTEMROOT",
    "PROGRAMFILES",
    "HOMEPATH",
  ])("rejects Native runtime/OS token reference collision %s", (name) => {
    const f = desktopFinancialEnvironmentFixture({
      authorizationAuthority: {
        url: "https://financial.example/authorize",
        serviceTokenEnvironmentVariable: name,
      },
    });
    try {
      expect(() =>
        captureDesktopPluginCreditSettlementEnvironment({
          ...f.environment,
          [name]: f.authorizationToken,
        }),
      ).toThrow();
    } finally {
      f.cleanup();
    }
  });

  it.each([
    "schema",
    "fields",
    "http",
    "query",
    "credentials",
    "scope",
    "batch",
    "missing-token",
  ])("fails closed on invalid explicit capture %s", (kind) => {
    const f = desktopFinancialEnvironmentFixture();
    try {
      const value: Record<string, unknown> = { ...f.document };
      if (kind === "schema") value.schemaVersion = "unknown";
      if (kind === "fields") value.extra = true;
      if (kind === "scope") value.scope = { tenantId: "standalone-tenant" };
      if (kind === "batch") value.batchSize = 17;
      if (["http", "query", "credentials"].includes(kind))
        value.authorizationAuthority = {
          ...f.document.authorizationAuthority,
          url:
            kind === "http"
              ? "http://financial.example/authorize"
              : kind === "query"
                ? "https://financial.example/authorize?q=1"
                : "https://user:secret@financial.example/authorize",
        };
      f.write(value);
      const ambient = { ...f.environment };
      if (kind === "missing-token") delete ambient[f.authorizationName];
      expect(() =>
        captureDesktopPluginCreditSettlementEnvironment(ambient),
      ).toThrow("desktop_plugin_credit_settlement_environment_invalid");
    } finally {
      f.cleanup();
    }
  });

  it.each(["permissions", "symlink", "hardlink", "UTF-8", "oversize"])(
    "rejects invalid private file %s",
    (kind) => {
      const f = desktopFinancialEnvironmentFixture();
      try {
        const ambient = { ...f.environment };
        if (kind === "permissions") chmodSync(f.path, 0o644);
        if (kind === "symlink") {
          const path = join(f.directory, "link.json");
          symlinkSync(f.path, path);
          ambient[DESKTOP_PLUGIN_CREDIT_SETTLEMENT_CONFIG_ENV] = path;
        }
        if (kind === "hardlink")
          linkSync(f.path, join(f.directory, "hard.json"));
        if (kind === "UTF-8") writeFileSync(f.path, Buffer.from([0xc3, 0x28]));
        if (kind === "oversize")
          writeFileSync(f.path, " ".repeat(64 * 1024 + 1));
        expect(() =>
          captureDesktopPluginCreditSettlementEnvironment(ambient),
        ).toThrow();
      } finally {
        f.cleanup();
      }
    },
  );

  it("never executes environment or target getters", () => {
    let calls = 0;
    const ambient: NodeJS.ProcessEnv = {};
    Object.defineProperty(
      ambient,
      DESKTOP_PLUGIN_CREDIT_SETTLEMENT_CONFIG_ENV,
      {
        enumerable: true,
        get() {
          calls++;
          return "/not/read.json";
        },
      },
    );
    expect(() =>
      captureDesktopPluginCreditSettlementEnvironment(ambient),
    ).toThrow();
    const owner = captureDesktopPluginCreditSettlementEnvironment({});
    try {
      const target = Object.defineProperty({}, "role", {
        enumerable: true,
        get() {
          calls++;
          return "worker";
        },
      });
      expect(() => owner.project({}, target as never)).toThrow();
      expect(calls).toBe(0);
    } finally {
      owner.close();
    }
  });

  it("one-shot shared launches retain unrelated values and consume no financial capability", () => {
    const f = desktopFinancialEnvironmentFixture();
    try {
      const value = desktopPluginCreditSettlementSharedEnvironment(
        f.environment,
      );
      expect(value[f.authorizationName]).toBeUndefined();
      expect(value[f.decisionName]).toBeUndefined();
      expect(
        value[DESKTOP_PLUGIN_CREDIT_SETTLEMENT_CONFIG_ENV],
      ).toBeUndefined();
      expect(value.CREWON_FINANCIAL_UNDECLARED_TOKEN).toBe(
        f.environment.CREWON_FINANCIAL_UNDECLARED_TOKEN,
      );
    } finally {
      f.cleanup();
    }
  });

  it("captures declarations from ambient while projecting an explicit custom launch environment", () => {
    const f = desktopFinancialEnvironmentFixture();
    try {
      const custom = {
        [f.authorizationName]: f.authorizationToken,
        [f.decisionName]: f.decisionToken,
        PATH: "/explicit/custom/tools",
        NAMED_CUSTOM_VALUE: "preserved",
      };
      expect(
        desktopPluginCreditSettlementSharedEnvironment(f.environment, {
          launchEnvironment: custom,
        }),
      ).toEqual({
        PATH: custom.PATH,
        NAMED_CUSTOM_VALUE: custom.NAMED_CUSTOM_VALUE,
      });
      expect(custom[f.authorizationName]).toBe(f.authorizationToken);
      expect(() =>
        desktopPluginCreditSettlementSharedEnvironment(f.environment, {
          launchEnvironment: {
            ...custom,
            [f.decisionName]: "conflicting-injected-token",
          },
        }),
      ).toThrow("overlay_conflict");
    } finally {
      f.cleanup();
    }
  });
});
