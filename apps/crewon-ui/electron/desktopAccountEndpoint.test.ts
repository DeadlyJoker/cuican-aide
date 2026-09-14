import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentPlatformBuildConfig } from "../agent-platform-build-config.ts";
import { readPackagedAccountOrigin } from "./desktopAccountEndpoint.ts";

const directories: string[] = [];
function manifest(contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), "crewon-account-endpoint-"));
  directories.push(directory);
  const path = join(directory, "desktop-account-endpoint.json");
  writeFileSync(path, contents);
  return path;
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true });
});

describe("packaged account endpoint", () => {
  it("uses the same configured account origin as the renderer", () => {
    const config = agentPlatformBuildConfig("desktop", {
      VITE_AGENT_PLATFORM_BASE_URL: "https://accounts.example.com/platform",
    });
    expect(
      readPackagedAccountOrigin(
        manifest(
          JSON.stringify({
            schemaVersion: 1,
            accountOrigin: new URL(config.accountBaseUrl).origin,
          }),
        ),
      ),
    ).toBe("https://accounts.example.com");
  });
  it.each([
    "null",
    "{}",
    "not-json",
    " ".repeat(2_049),
    JSON.stringify({
      schemaVersion: 2,
      accountOrigin: "https://accounts.example.com",
    }),
    JSON.stringify({
      schemaVersion: 1,
      accountOrigin: "http://accounts.example.com",
    }),
    JSON.stringify({
      schemaVersion: 1,
      accountOrigin: "https://user:secret@accounts.example.com",
    }),
  ])("rejects malformed or unsafe manifest %#", (contents) => {
    expect(() => readPackagedAccountOrigin(manifest(contents))).toThrow();
  });
});
