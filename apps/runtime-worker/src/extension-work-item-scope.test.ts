import assert from "node:assert/strict";
import test from "node:test";
import { getComfyImplementationDigest } from "@crewon/agent-version/extension-build";
import { bundledComfyRegistration } from "./extensions/comfyui-bundled-registration.ts";
import {
  extensionWorkItemExecutionScope,
  parseExtensionExecutionMode,
} from "./extensions/extension-work-item-scope.ts";

test("current and historical Worker affinity always uses this verified loaded implementation", () => {
  const digest = bundledComfyRegistration().implementationDigest;
  // Persisted plugin configs use the manifest+adapter identity, not its build input alone.
  assert.notEqual(digest, getComfyImplementationDigest());
  for (const mode of ["current", "historical"] as const) {
    const scope = extensionWorkItemExecutionScope({
      tenantId: "tenant",
      mode,
      targets: [],
    });
    assert.deepEqual(scope, {
      tenantId: "tenant",
      extensionImplementationDigest: digest,
      unboundRuns: mode === "current" ? "include" : "exclude",
      extensionTargets: [],
    });
    assert.ok(Object.isFrozen(scope));
  }
  assert.equal(parseExtensionExecutionMode(undefined), "current");
  for (const value of [null, "", " current", "historical ", true, "all"])
    assert.throws(
      () => parseExtensionExecutionMode(value),
      /extension_execution_mode_invalid/u,
    );
});
