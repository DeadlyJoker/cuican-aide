import assert from "node:assert/strict";
import test from "node:test";

import { runtimeNativeReadinessLines } from "./runtime-native-readiness.ts";

test("projects only actual non-secret origins and runtime bindings", () => {
  const lines = runtimeNativeReadinessLines({
    providerRuntimeBindingId: "provider-generation-1",
    workspacePrivateOrigin: "http://127.0.0.1:43210",
    workspaceRuntimeBindingId: "workspace-generation-1",
  });
  assert.deepEqual(lines, [
    "CrewON Provider Runtime ready:provider-generation-1",
    "CrewON Workspace Runtime ready:http://127.0.0.1:43210:workspace-generation-1",
  ]);
  const output = lines.join("\n");
  assert.doesNotMatch(
    output,
    /private-token|PRIVATE KEY|CERTIFICATE|workspace-secret-path/u,
  );
});

test("default unavailable mode emits no listener origin", () => {
  assert.deepEqual(
    runtimeNativeReadinessLines({
      providerRuntimeBindingId: null,
      workspacePrivateOrigin: null,
      workspaceRuntimeBindingId: null,
    }),
    [
      "CrewON Provider Runtime ready:none",
      "CrewON Workspace Runtime ready:none:none",
    ],
  );
});
