import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopNativeProjectWorkspaceRuntime as create } from "./desktop-native-project-workspace-runtime.ts";
type Config = Parameters<typeof create>[0]["configuration"];
test("legacy and metadata-only owned configuration do not acquire the parent channel or require Native authority", () => {
  assert.equal(
    create({
      configuration: {
        schemaVersion: "crewon.desktop-plugin-bootstrap.v1",
      } as Config,
      nativeControl: undefined,
    }),
    undefined,
  );
  assert.equal(
    create({
      configuration: {
        schemaVersion: "crewon.desktop-plugin-bootstrap.v2",
        projects: { conversations: { projectOwnership: "plugin-project-v1" } },
      } as Config,
      nativeControl: undefined,
    }),
    undefined,
  );
});
