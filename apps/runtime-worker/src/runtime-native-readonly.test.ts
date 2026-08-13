import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import {
  RuntimeNativeReadonlyService,
  decodeGitOutput,
} from "./runtime-native-readonly.ts";

const run = promisify(execFile);
const authority = {
  tenantId: "tenant-1",
  spaceId: "space-1",
  workspaceBindingId: "workspace-1",
  incarnationId: "incarnation-1",
  runtimeBindingId: "runtime-1",
  policySnapshotId: "policy-1",
};

test("literal search is bounded, scoped, and does not follow links", async (context) => {
  const root = await fixture(context);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "a.ts"), "needle one\nnone\nneedle two\n");
  await writeFile(join(root, "outside.txt"), "needle outside");
  await symlink(join(root, "outside.txt"), join(root, "src", "linked.txt"));
  const service = new RuntimeNativeReadonlyService({ root, authority });
  const result = await service.execute(
    {
      schemaVersion: "crewon.workspace-native-readonly-request.v0",
      operation: "contentSearch",
      tenantId: "tenant-1",
      spaceId: "space-1",
      workspaceBindingId: "workspace-1",
      pathSegments: ["src"],
      query: "needle",
      maxMatches: 1,
    },
    new AbortController().signal,
  );
  assert.deepEqual(result, {
    schemaVersion: "crewon.workspace-native-readonly-response.v0",
    operation: "contentSearch",
    workspaceBindingId: "workspace-1",
    matches: [{ path: "src/a.ts", line: 1, preview: "needle one" }],
    scannedFiles: 1,
    scannedBytes: 27,
    truncated: true,
  });
  await assert.rejects(
    service.execute(
      {
        schemaVersion: "crewon.workspace-native-readonly-request.v0",
        operation: "gitStatus",
        tenantId: "tenant-2",
        spaceId: "space-1",
        workspaceBindingId: "workspace-1",
      },
      new AbortController().signal,
    ),
    /workspace_native_scope_denied/u,
  );
});

test("search rejects linked path components and cancellation", async (context) => {
  const root = await fixture(context);
  const outside = await fixture(context);
  await symlink(outside, join(root, "escape"));
  const service = new RuntimeNativeReadonlyService({ root, authority });
  await assert.rejects(
    service.execute(search(["escape"]), new AbortController().signal),
    /workspace_native_link_unsupported/u,
  );
  const controller = new AbortController();
  controller.abort(new Error("canceled"));
  await assert.rejects(
    service.execute(search([]), controller.signal),
    /canceled/u,
  );
});

test("Git status exposes fixed read-only metadata", async (context) => {
  const root = await fixture(context);
  await run("git", ["init", "-q", "-b", "main"], { cwd: root });
  await run("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await run("git", ["config", "user.name", "Test"], { cwd: root });
  await writeFile(join(root, "tracked.txt"), "one");
  await run("git", ["add", "tracked.txt"], { cwd: root });
  await run("git", ["commit", "-qm", "initial"], { cwd: root });
  await writeFile(join(root, "tracked.txt"), "two");
  await writeFile(join(root, "new.txt"), "new");
  const marker = join(root, "fsmonitor-ran");
  const hook = join(root, "malicious-fsmonitor.sh");
  await writeFile(hook, `#!/bin/sh\nprintf ran > '${marker}'\n`);
  await chmod(hook, 0o700);
  await run("git", ["config", "core.fsmonitor", hook], { cwd: root });
  const service = new RuntimeNativeReadonlyService({ root, authority });
  const result = await service.execute(
    {
      schemaVersion: "crewon.workspace-native-readonly-request.v0",
      operation: "gitStatus",
      tenantId: "tenant-1",
      spaceId: "space-1",
      workspaceBindingId: "workspace-1",
    },
    new AbortController().signal,
  );
  assert.equal(result.operation, "gitStatus");
  if (result.operation !== "gitStatus") return;
  assert.equal(result.branch, "main");
  assert.match(result.head ?? "", /^[a-f0-9]{40}$/u);
  assert.deepEqual(result.entries, [
    { index: " ", worktree: "M", path: "tracked.txt" },
    { index: "?", worktree: "?", path: "malicious-fsmonitor.sh" },
    { index: "?", worktree: "?", path: "new.txt" },
  ]);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

test("Git output rejects non-UTF-8 bytes", () => {
  assert.throws(
    () => decodeGitOutput(Buffer.from([0xff])),
    /workspace_native_git_output_invalid/u,
  );
});

function search(pathSegments: readonly string[]) {
  return {
    schemaVersion: "crewon.workspace-native-readonly-request.v0" as const,
    operation: "contentSearch" as const,
    tenantId: "tenant-1",
    spaceId: "space-1",
    workspaceBindingId: "workspace-1",
    pathSegments,
    query: "needle",
    maxMatches: 10,
  };
}
async function fixture(context: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "crewon-native-readonly-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
