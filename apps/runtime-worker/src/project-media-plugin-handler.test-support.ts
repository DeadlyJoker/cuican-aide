import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  installLocalPluginPackage,
  loadInstalledPluginBusinessRegistration,
  PluginExecutionPackage,
} from "@crewon/plugin-host";
import type { PluginToolRuntime } from "@crewon/plugin-sdk/node";
import type {
  ToolExecutionCommand,
  ToolExecutionResolution,
} from "@crewon/tool-broker";
import { mediaExecutionFixture } from "./project-media-execution.test-support.ts";
import { installedPluginMediaHostService } from "./plugins/installed-plugin-media-execution.ts";
import type { ProjectMediaExecutionBoundary } from "./project-media-execution-boundary.ts";
import { command, rebind } from "./plugin-tool-runtime-adapter.test-support.ts";

function removeOwnedInstalled(directory: string): void {
  chmodSync(directory, 0o700);
  for (const entry of readdirSync(directory, { withFileTypes: true }))
    if (entry.isDirectory()) removeOwnedInstalled(join(directory, entry.name));
  rmSync(directory, { recursive: true });
}

/** Actual independent package install/read/setup/factory and admitted native media Run/IO.
 * PDP/readiness, private receipt issuer, DNS/supplier responses remain named fixtures.
 * This is not a complete RuntimeWorker loop, Main or Agent model acceptance.
 */
export async function mediaPluginFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  kind: "T10" | "D18" = "T10",
) {
  const root = mkdtempSync(join(tmpdir(), "crewon-short21-handler-"));
  const ownedIdentity = statSync(root);
  const opened: { close(): Promise<void> }[] = [];
  t.after(async () => {
    try {
      await Promise.all(opened.map((o) => o.close()));
    } finally {
      const current = statSync(root);
      assert.equal(current.dev, ownedIdentity.dev);
      assert.equal(current.ino, ownedIdentity.ino);
      removeOwnedInstalled(root);
    }
  });
  const pkg = await installLocalPluginPackage({
    directory: resolve(
      process.env.CREWON_MEDIA_HANDLER_PACKAGE_DIR ??
        fileURLToPath(
          new URL(
            "../../../output/extensions/installable-plugins/short-drama-media-handler-20261006/short-drama/21.0.0",
            import.meta.url,
          ),
        ),
    ),
    installRoot: root,
    authorization: async () => ({ outcome: "allow" }),
  });
  assert.equal(pkg.descriptor.version, "21.0.0");
  const registration = await loadInstalledPluginBusinessRegistration({
    installRoot: root,
    expectedPluginId: pkg.descriptor.pluginId,
    expectedPublisherId: pkg.descriptor.publisherId,
    expectedVersion: pkg.descriptor.version,
    expectedPackageDigest: pkg.packageDigest,
    authorizeRead: async () => "allow",
    signal: new AbortController().signal,
  });
  const f = await mediaExecutionFixture(t, backend, kind, {
    installedFixture: {
      version: pkg.descriptor.version,
      publisherId: pkg.descriptor.publisherId,
      packageDigest: pkg.packageDigest,
      manifestDigest: registration.manifestDigest,
      implementationDigest: registration.implementationDigest,
      preset: "krea2-portrait",
      manifest: registration.manifest,
    },
  });
  const open = async (boundary: ProjectMediaExecutionBoundary = f.boundary) => {
    const io = f.owner(boundary);
    let active = true;
    const service = installedPluginMediaHostService({
      context: boundary.context,
      io: () => io,
      assertActive: () => {
        if (!active) throw new Error("named_installed_media_owner_closed");
      },
    });
    const owner = await PluginExecutionPackage.open({
      activation: {
        installRoot: root,
        expectedPluginId: pkg.descriptor.pluginId,
        expectedPackageDigest: pkg.packageDigest,
        authorizeActivation: async () => "allow" as const,
      },
      hostServices: [service],
      commit: { authorizeCommit: () => "allow" },
    });
    const borrow = owner.acquire({
      purpose: "newOperation",
      authorizeBorrow: () => "allow",
    });
    assert.equal(
      borrow.identity.packageDigest,
      f.context.identity.packageDigest,
    );
    const runtime = await borrow.factory.create(boundary.context, io.services);
    assert.deepEqual(
      runtime
        .definitions()
        .map((d) => d.name)
        .sort(),
      registration.manifest.tools
        .map((d) => `crewon_short_drama__${d.operationId}`)
        .sort(),
    );
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      active = false;
      await runtime.close?.();
      await io.close();
      borrow.release();
      await owner.close();
    };
    opened.push({ close });
    return { runtime, io, service, owner, close };
  };
  const makeCommand = (
    runtime: PluginToolRuntime,
    name = "media_submit",
    input = {},
  ) => {
    const {
      actionIntent: _intent,
      actionDigest: _digest,
      ...base
    } = f.makeCommand(name === "media_observe" ? "observe" : "submit");
    const policy = runtime.executionPolicy(
      "function",
      `crewon_short_drama__${name}`,
    );
    assert.ok(policy);
    return rebind(
      command(
        {
          ...base,
          name: `crewon_short_drama__${name}`,
          input: JSON.stringify(input),
        },
        policy,
      ),
      {
        policySnapshotId: f.context.target.policySnapshotId,
        workspaceBindingId: f.context.target.workspaceBindingId,
      },
    );
  };
  const invoke = async (
    opened: Awaited<ReturnType<typeof open>>,
    command: ToolExecutionCommand,
    method: "execute" | "reconcile" | "cancel" = "execute",
    signal = f.signal().signal,
  ) => {
    let result: ToolExecutionResolution | null = null;
    await f.invoke(
      opened.io,
      command,
      async (checked) => {
        result = await opened.runtime[method](checked, signal);
      },
      signal,
      method,
    );
    assert.ok(result);
    return result as ToolExecutionResolution;
  };
  return { ...f, root, pkg, registration, open, makeCommand, invoke };
}
export function mediaOutput(result: ToolExecutionResolution) {
  assert.equal(result.status, "completed");
  if (result.status !== "completed")
    throw new Error("expected_completed_media_tool");
  return JSON.parse(JSON.parse(result.result.output).resultJson);
}
