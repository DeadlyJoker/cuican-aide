import assert from "node:assert/strict";
import { readFileSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type {
  DeviceFilesystemReadCommand,
  DeviceWorkspaceListCommand,
} from "@crewon/contracts";

import {
  LocalWorkspaceListDispatchClient,
  LocalWorkspaceReadGatewayClient,
} from "./runtime-local-workspace.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../packages/test-contracts/fixtures/device-protocol.reference.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  valid: {
    workspaceCommand: DeviceWorkspaceListCommand;
    filesystemReadCommand: DeviceFilesystemReadCommand;
  };
};

test("local Workspace list is bounded, byte-sorted, and replayable", async (context) => {
  const root = await workspace(context);
  await mkdir(join(root, "alpha"));
  await writeFile(join(root, "README.md"), "hello");
  const command = active(fixture.valid.workspaceCommand);
  const client = new LocalWorkspaceListDispatchClient({
    root,
    authority: listAuthority(command),
  });

  const first = await client.execute(command, new AbortController().signal);
  assert.deepEqual(await client.execute(command, new AbortController().signal), first);
  assert.deepEqual(first.status === "completed" ? first.terminal.data.result.entries : null, [
    { name: "README.md", kind: "file" },
    { name: "alpha", kind: "directory" },
  ]);
});

test("local Workspace list rejects symbolic links", async (context) => {
  const root = await workspace(context);
  await writeFile(join(root, "target.txt"), "target");
  symlinkSync(join(root, "target.txt"), join(root, "linked.txt"));
  const command = active(fixture.valid.workspaceCommand);
  const client = new LocalWorkspaceListDispatchClient({
    root,
    authority: listAuthority(command),
  });
  await assert.rejects(
    client.execute(command, new AbortController().signal),
    /workspace_list_link_entry_unsupported/u,
  );
});

test("local Workspace read is replayable and rejects symbolic-link escape", async (context) => {
  const root = await workspace(context);
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "docs", "README.md"), "local workspace");
  const command = active(fixture.valid.filesystemReadCommand);
  const authority = {
    workspaceBindingId: command.workspaceBindingId!,
    incarnationId: command.arguments.workspaceIncarnationId,
    deviceBindingId: "device-binding-1",
    deviceId: command.deviceId,
    runtimeBindingId: "runtime-binding-1",
  };
  const client = new LocalWorkspaceReadGatewayClient({ root, authority });
  const route = {
    deviceBindingId: authority.deviceBindingId,
    runtimeBindingId: authority.runtimeBindingId,
  };
  const first = await client.execute(route, command, new AbortController().signal);
  assert.deepEqual(await client.execute(route, command, new AbortController().signal), first);
  assert.equal(
    first.status === "completed" ? first.terminal.data.result.content : null,
    "local workspace",
  );

  await rm(join(root, "docs", "README.md"));
  symlinkSync(tmpdir(), join(root, "docs", "README.md"));
  const forged = { ...command, executionId: "filesystem-read-symlink" };
  await assert.rejects(
    client.execute(route, forged, new AbortController().signal),
    /workspace_read_link_unsupported/u,
  );
});

async function workspace(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "crewon-runtime-local-workspace-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function active<T extends DeviceWorkspaceListCommand | DeviceFilesystemReadCommand>(
  input: T,
): T {
  const now = Date.now();
  return {
    ...structuredClone(input),
    expiresAt: new Date(now + 60_000).toISOString(),
    authorization: {
      ...input.authorization,
      issuedAt: new Date(now - 1_000).toISOString(),
      expiresAt: new Date(now + 30_000).toISOString(),
    },
  };
}

function listAuthority(command: DeviceWorkspaceListCommand) {
  return {
    workspaceBindingId: command.workspaceBindingId,
    incarnationId: command.incarnationId,
    deviceBindingId: command.deviceBindingId,
    deviceId: command.deviceId,
    runtimeBindingId: command.runtimeBindingId,
  };
}
