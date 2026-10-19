import { expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeProjectWorkspaceBridgeFixture } from "./desktopNativeProjectWorkspaceBridge.test-support.ts";

it("joins a real child that never announces ready before rejecting and deleting its fixture", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "crewon-workspace-ready-failure-"),
  );
  const pidPath = join(directory, "child.pid");
  let fixtureDirectory: string | undefined;
  const started = performance.now();
  try {
    await expect(
      nativeProjectWorkspaceBridgeFixture(
        "none",
        `
      const {writeFileSync}=await import("node:fs");
      writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
      process.on("message",()=>{});
    `,
        {
          beforeBootstrap(fixture) {
            fixtureDirectory = fixture.directory;
          },
        },
      ),
    ).rejects.toThrow("fixture_message_deadline");
    expect(performance.now() - started).toBeGreaterThanOrEqual(5000);
    const pid = Number(readFileSync(pidPath, "utf8"));
    expect(Number.isSafeInteger(pid)).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" }),
    );
    expect(fixtureDirectory).toBeDefined();
    expect(existsSync(fixtureDirectory!)).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 15000);
