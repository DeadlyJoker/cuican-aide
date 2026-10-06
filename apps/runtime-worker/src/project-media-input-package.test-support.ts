import assert from "node:assert/strict";
import { mkdtempSync, statSync, chmodSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import {
  installLocalPluginPackage,
  loadInstalledPluginBusinessRegistration,
  PluginNodeHost,
} from "@crewon/plugin-host";
import type {
  PluginToolRuntimeFactory,
  PluginToolRuntime,
} from "@crewon/plugin-sdk/node";
import type {
  MediaInputToolMethod,
  MediaInputToolRequests,
} from "@crewon/contracts/project-media-input-tools";
import { parseMediaInputToolResponse } from "@crewon/contracts/project-media-input-tools";
import { mediaInputToolsOwnerFixture } from "./project-media-input-tools-owner.test-support.ts";
import type { ProjectMediaInputToolsServiceOwnerDependencies } from "./plugins/project-media-input-tools-service-owner.ts";

function removeOwned(path: string) {
  chmodSync(path, 0o700);
  for (const e of readdirSync(path, { withFileTypes: true }))
    if (e.isDirectory()) removeOwned(join(path, e.name));
  rmSync(path, { recursive: true });
}
/** Actual installed package and PluginNodeHost, original native Stage/Run/Tool/SQL. Dispatch issuer and policy are named fixtures; no model/resolver/Composer acceptance. */
export async function mediaInputPackageFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  kind: "T10" | "D18" = "T10",
) {
  const root = mkdtempSync(join(tmpdir(), "crewon-media-input-package-")),
    inode = statSync(root);
  const hosts: PluginNodeHost[] = [],
    runtimes: PluginToolRuntime[] = [];
  t.after(async () => {
    for (const runtime of runtimes) await runtime.close?.();
    for (const host of hosts) await host.close();
    const actual = statSync(root);
    assert.equal(actual.dev, inode.dev);
    assert.equal(actual.ino, inode.ino);
    removeOwned(root);
  });
  const pkg = await installLocalPluginPackage({
    directory: resolve(
      process.env.CREWON_MEDIA_INPUT_PACKAGE_DIR ??
        "output/extensions/installable-plugins/short-drama-media-input-agent-20261006/short-drama/23.0.0",
    ),
    installRoot: root,
    authorization: async () => ({ outcome: "allow" }),
  });
  const registration = await loadInstalledPluginBusinessRegistration({
    installRoot: root,
    expectedPluginId: pkg.descriptor.pluginId,
    expectedPublisherId: pkg.descriptor.publisherId,
    expectedVersion: pkg.descriptor.version,
    expectedPackageDigest: pkg.packageDigest,
    authorizeRead: async () => "allow",
    signal: new AbortController().signal,
  });
  const f = await mediaInputToolsOwnerFixture(t, backend, kind, {
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
  async function activate(
    options: Readonly<{
      service?: "present" | "absent";
      overrides?: Partial<ProjectMediaInputToolsServiceOwnerDependencies>;
    }> = {},
  ) {
    const owner = f.owner(options.overrides);
    let factory: PluginToolRuntimeFactory | null = null;
    const host = new PluginNodeHost({
      services: [
        ...(options.service === "absent" ? [] : owner.hostServices()),
        {
          service: "crewon.execution",
          apiVersion: "1",
          value: {
            register(value: PluginToolRuntimeFactory) {
              assert.equal(factory, null);
              factory = value;
              return {
                dispose() {
                  factory = null;
                },
              };
            },
          },
        },
      ],
    });
    hosts.push(host);
    await host.activate({
      installRoot: root,
      expectedPluginId: pkg.descriptor.pluginId,
      expectedPackageDigest: pkg.packageDigest,
      authorizeActivation: () => "allow",
    });
    assert.ok(factory);
    const runtime = await (factory as PluginToolRuntimeFactory).create(
      f.context,
      { approvalRequirement: "none" },
    );
    runtimes.push(runtime);
    const policy = runtime.executionPolicy(
      "function",
      "crewon_short_drama__media_input",
    );
    assert.ok(policy);
    assert.equal(policy.effect, "mutation");
    assert.equal(policy.recovery, "reconcilable");
    assert.equal(policy.capability, "project.media-input.write");
    const prepare = <M extends MediaInputToolMethod>(
      method: M,
      request: MediaInputToolRequests[M],
    ) => f.prepareTool(method, request, { policy });
    const run = (
      op: Awaited<ReturnType<typeof prepare>>,
      method: "execute" | "reconcile" | "cancel" = "execute",
      signal: AbortSignal = new AbortController().signal,
    ) =>
      f.invoke(
        owner,
        op,
        (command) => {
          const invoke = runtime[method];
          assert.ok(invoke);
          return invoke.call(runtime, command, signal);
        },
        { method, signal },
      );
    async function call<M extends MediaInputToolMethod>(
      method: M,
      request: MediaInputToolRequests[M],
    ) {
      const op = await prepare(method, request),
        result = await run(op);
      assert.equal(result.status, "completed");
      if (result.status !== "completed") throw new Error("result_missing");
      assert.ok(Buffer.byteLength(result.result.output) <= 8192);
      const outer = JSON.parse(result.result.output);
      assert.deepEqual(Object.keys(outer), ["resultJson"]);
      return {
        op,
        result,
        value: parseMediaInputToolResponse(
          method,
          request,
          JSON.parse(outer.resultJson),
        ),
      };
    }
    return { runtime, owner, host, policy, prepare, run, call };
  }
  return { ...f, pkg, registration, activate };
}
