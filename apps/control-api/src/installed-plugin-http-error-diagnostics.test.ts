import assert from "node:assert/strict";
import test from "node:test";
import { createInstalledPluginHttpErrorDiagnostics } from "./installed-plugin-http-error-diagnostics.ts";

test("disabled and malformed public error diagnostics remain silent", () => {
  const lines: string[] = [];
  const sink = (line: string) => {
    lines.push(line);
  };
  createInstalledPluginHttpErrorDiagnostics(false, sink)(
    "req-a",
    "internal_error",
    500,
  );
  const report = createInstalledPluginHttpErrorDiagnostics(true, sink);
  report("private request", "internal_error", 500);
  report("req-a", "private/body", 500);
  report("req-a", "internal_error", 200);
  assert.deepEqual(lines, []);
});

test("public error codes are bounded and backpressure or sink failures never propagate", () => {
  const lines: string[] = [];
  const report = createInstalledPluginHttpErrorDiagnostics(true, (line) => {
    lines.push(line);
  });
  for (let i = 0; i < 100; i++)
    report("req-a", "plugin_query_source_changed", 409);
  assert.equal(lines.length, 32);
  assert.deepEqual(JSON.parse(lines[0]!.split(":").slice(1).join(":")), {
    requestId: "req-a",
    code: "plugin_query_source_changed",
    statusCode: 409,
  });
  let calls = 0;
  for (const throws of [false, true]) {
    const stop = createInstalledPluginHttpErrorDiagnostics(true, () => {
      calls++;
      if (throws) throw new Error("private");
      return false;
    });
    stop("req-a", "internal_error", 500);
    stop("req-a", "internal_error", 500);
  }
  assert.equal(calls, 2);
});
