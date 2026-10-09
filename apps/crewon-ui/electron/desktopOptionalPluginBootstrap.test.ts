import { writeFileSync } from "node:fs";
import { describe, expect, it, vi, afterEach } from "vitest";
import { DESKTOP_RUNTIME_OWNER } from "./desktopExtensionRuntime.ts";
import { desktopPluginManagementFixture } from "./desktopPluginManagementRuntime.test-support.ts";
import { prepareOptionalDesktopPluginBootstrap } from "./desktopOptionalPluginBootstrap.ts";

afterEach(() => vi.unstubAllEnvs());

describe("optional Native plugin preparation", () => {
  it("waits for withdrawal before quarantining rejected preparation", async () => {
    let closed = false;
    const result = await prepareOptionalDesktopPluginBootstrap(
      {
        prepared: async () => {
          throw new Error("private-configuration-secret");
        },
        close: async () => {
          closed = true;
        },
      },
      new AbortController().signal,
    );
    expect(closed).toBe(true);
    expect(result).toEqual({ state: "quarantined", bootstrap: null });
  });

  it("does not turn failed cleanup into base startup permission", async () => {
    await expect(
      prepareOptionalDesktopPluginBootstrap(
        {
          prepared: async () => {
            throw new Error("invalid-input");
          },
          close: async () => {
            throw new Error("cleanup-failed");
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("cleanup-failed");
  });

  it("joins cleanup but propagates cancellation", async () => {
    const controller = new AbortController();
    controller.abort(new Error("shutdown-requested"));
    const close = vi.fn(async () => {});
    await expect(
      prepareOptionalDesktopPluginBootstrap(
        {
          prepared: async () => {
            throw new Error("invalid-input");
          },
          close,
        },
        controller.signal,
      ),
    ).rejects.toThrow("shutdown-requested");
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("Native child startup when plugin approval is invalid", () => {
  it.each(["malformed", "foreign-actor"] as const)(
    "preserves provider, base identity and restart while quarantining %s inputs",
    async (kind) => {
      const f = desktopPluginManagementFixture({
        provider: "configured",
        approval: "present",
      });
      const canary = "private-invalid-plugin-input";
      if (kind === "malformed") writeFileSync(f.approvalPath, `{${canary}`);
      else f.writeApproval({ ...f.approval, actor: { principalId: canary } });
      vi.stubEnv(
        "CREWON_DESKTOP_NATIVE_PLUGIN_CONTROL_PATH",
        "/ambient/private-control.json",
      );
      vi.stubEnv(
        "CREWON_DESKTOP_NATIVE_PLUGIN_AUTHORITY_PATH",
        "/ambient/private-authority.json",
      );
      vi.stubEnv(
        "CREWON_DESKTOP_INSTALLED_PLUGIN_PEER_TOKEN",
        "ambient-secret",
      );
      try {
        await f.owner.start();
        expect(() => f.owner.session()).not.toThrow();
        expect(f.owner.localManagementAccess()).toBeNull();
        const first = f.records();
        expect(first.map((r) => r.kind).sort()).toEqual([
          "control",
          "release",
          "worker",
        ]);
        for (const record of first) {
          expect(record.actor).toEqual(DESKTOP_RUNTIME_OWNER);
          expect(record.modelApiKey).toBe("fixture-model-secret");
          expect(record.bootstrapPath).toBeNull();
          expect(record.ambientPluginKeys).toEqual([]);
        }
        expect(f.bootstrapFiles()).toEqual([]);
        expect(f.logs.join("")).toContain(
          "desktop_plugin_bootstrap_quarantined",
        );
        expect(f.logs.join("")).not.toContain(canary);
        await f.owner.stop();
        await f.owner.start();
        expect(() => f.owner.session()).not.toThrow();
        expect(f.records().filter((r) => r.kind === "control")).toHaveLength(2);
        await f.owner.stop();
        f.writeApproval();
        await f.owner.start();
        expect(f.owner.localManagementAccess()).not.toBeNull();
        expect(
          f
            .records()
            .filter((r) => r.kind === "control")
            .at(-1)?.bootstrapPath,
        ).not.toBeNull();
      } finally {
        await f.close();
      }
    },
  );

  it("keeps base settings Control available with invalid approval and no model provider", async () => {
    const f = desktopPluginManagementFixture({
      provider: "absent",
      approval: "present",
    });
    writeFileSync(f.approvalPath, "invalid-json");
    try {
      await f.owner.start();
      expect(f.records().map((r) => r.kind)).toEqual(["control"]);
      expect(f.records()[0]?.actor).toEqual(DESKTOP_RUNTIME_OWNER);
      expect(f.records()[0]?.bootstrapPath).toBeNull();
      expect(f.owner.localManagementAccess()).toBeNull();
    } finally {
      await f.close();
    }
  });
});
