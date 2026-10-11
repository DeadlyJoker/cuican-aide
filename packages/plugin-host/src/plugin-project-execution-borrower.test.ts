import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { capturePluginHistoricalQueryInvocationCommitAuthority } from "@crewon/application";
import { installLocalPluginPackage } from "./local-plugin-package-installer.ts";
import { PluginNodeHost } from "./plugin-node-host.ts";
import { projectGenerationExecutionFixture } from "./plugin-project-generation-execution-bridge.test-support.ts";
import { projectGenerationQueryExecutionFixture } from "./plugin-project-generation-query-execution-bridge.test-support.ts";
import { projectHistoricalQueryExecutionFixture } from "./plugin-project-historical-query-execution-bridge.test-support.ts";
import type { PluginProjectExecutionBorrower } from "./plugin-project-execution-borrower.ts";

/** Real installed bytes/Host/leases; Application receipts use explicit memory fixtures, not SQL admission. */
async function actualGenerationTarget(t: TestContext) {
  const f = projectGenerationExecutionFixture();
  const root = await mkdtemp(join(tmpdir(), "crewon-project-borrower-"));
  await chmod(root, 0o700);
  const source = join(root, "source");
  const installRoot = join(root, "installed");
  await mkdir(source, { mode: 0o700 });
  await mkdir(installRoot, { mode: 0o700 });
  const key = `project-borrower-${randomUUID()}`;
  const globals = globalThis as unknown as Record<string, unknown>;
  const probe = { setups: 0, disposals: 0, borrows: 0, releases: 0 };
  globals[key] = probe;
  const pin = f.input.executionPin;
  const node = `export default {apiVersion:'crewon.plugin-host.v1',pluginId:${JSON.stringify(pin.pluginId)},setup(ctx){const probe=globalThis[${JSON.stringify(key)}];probe.setups++;const tasks=ctx.services.get('crewon.tasks','1');ctx.services.provide(${JSON.stringify(pin.pluginId)},'1',{actions:[{contributionId:${JSON.stringify(pin.contributionId)},action:${JSON.stringify(pin.action)},kind:'generateTask'}],invoke({input,invocationRef}){return tasks.createTask({...input,invocationRef});}});return {dispose(){probe.disposals++;}};}};`;
  const files = new Map([
    ["node.mjs", Buffer.from(node)],
    ["ui.mjs", Buffer.from("export default {};")],
  ]);
  const descriptor = {
    ...f.input.targetCandidate.descriptor,
    files: [...files].map(([path, bytes]) => ({
      path,
      byteLength: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })),
  };
  for (const [path, bytes] of files) await writeFile(join(source, path), bytes);
  await writeFile(
    join(source, "crewon.plugin.json"),
    JSON.stringify(descriptor),
  );
  const installed = await installLocalPluginPackage({
    directory: source,
    installRoot,
    authorization: async () => ({ outcome: "allow" }),
  });
  const host = new PluginNodeHost({
    services: [f.bridge.hostService(), f.bridge.hostServiceV2()],
  });
  t.after(async () => {
    await host.close();
    delete globals[key];
    await chmod(installed.directory, 0o700);
    await rm(root, { recursive: true, force: true });
  });
  const prepared = await host.prepare({
    installRoot,
    expectedPluginId: pin.pluginId,
    expectedPackageDigest: installed.packageDigest,
    authorizeActivation: () => "allow",
  });
  prepared.commit({ authorizeCommit: () => "allow" });
  const input = {
    ...f.input,
    executionPin: { ...pin, packageDigest: installed.packageDigest },
    targetCandidate: {
      descriptor: installed.descriptor,
      packageDigest: installed.packageDigest,
    },
    publication: {
      ...f.input.publication,
      target: {
        ...f.input.publication.target,
        packageDigest: installed.packageDigest,
      },
    },
    commit: async (received: Parameters<typeof f.input.commit>[0]) => {
      await received.authority.assertTransactionCurrent();
      received.authority.assertActive();
      return (await f.f.app.accept(f.input.context)).result;
    },
  };
  const borrower: PluginProjectExecutionBorrower = {
    borrow({ executionPin, authorizeBorrow }) {
      const lease = host.acquire({
        pluginId: executionPin.pluginId,
        packageDigest: executionPin.packageDigest,
        purpose: "newOperation",
        authorizeBorrow,
      });
      probe.borrows++;
      return {
        lease,
        release() {
          probe.releases++;
          lease.release();
        },
      };
    },
  };
  const execute = async (next = input, owner = borrower) => {
    const dispose = f.f.register(next.context);
    try {
      return await f.bridge.executeFromBorrower(owner, next);
    } finally {
      dispose();
    }
  };
  return { f, input, host, probe, execute, borrower };
}

test("project generation borrows one real installed target across calls without another setup", async (t) => {
  const f = await actualGenerationTarget(t);
  const first = await f.execute();
  assert.equal(first.result.turn.disposition, "committed");
  const replay = await f.execute();
  assert.equal(replay.result.turn.disposition, "replayed");
  assert.equal(f.probe.setups, 1);
  assert.ok(f.probe.borrows > 2);
  assert.equal(f.probe.borrows, f.probe.releases);
  await f.host.close();
  assert.equal(f.probe.disposals, 1);
});

test("target withdrawal before the original transaction fence cannot submit and releases the held borrow", async (t) => {
  const f = await actualGenerationTarget(t);
  await assert.rejects(
    f.execute({
      ...f.input,
      commit: async (received) => {
        f.host.deactivate(f.input.executionPin.pluginId);
        await received.authority.assertTransactionCurrent();
        throw new Error("must_not_pass_withdrawn_target");
      },
    }),
  );
  assert.equal(f.probe.borrows, f.probe.releases);
  assert.equal(f.probe.setups, 1);
  await f.host.close();
  assert.equal(f.probe.disposals, 1);
});

for (const mode of ["copied", "released", "extra", "accessor"] as const) {
  test(`project target borrower refuses a ${mode} real lease and releases its physical handle`, async (t) => {
    const f = await actualGenerationTarget(t);
    let getterCalls = 0;
    const owner: PluginProjectExecutionBorrower = {
      borrow(input) {
        const handle = f.borrower.borrow(input);
        if (mode === "released") handle.lease.release();
        if (mode === "copied")
          return { lease: { ...handle.lease }, release: handle.release };
        if (mode === "extra") return { ...handle, extra: true };
        if (mode === "accessor")
          return Object.defineProperty({ release: handle.release }, "lease", {
            enumerable: true,
            get() {
              getterCalls++;
              return handle.lease;
            },
          }) as ReturnType<PluginProjectExecutionBorrower["borrow"]>;
        return handle;
      },
    };
    await assert.rejects(f.execute(f.input, owner));
    assert.equal(getterCalls, 0);
    assert.equal(f.probe.borrows, f.probe.releases);
  });
}

test("all three project execution adapters reject an unissued lease instead of trusting a structural copy", async () => {
  const generation = projectGenerationExecutionFixture();
  const query = await projectGenerationQueryExecutionFixture();
  const historical = await projectHistoricalQueryExecutionFixture();
  for (const f of [generation, query, historical]) {
    const dispose = f.f.register(f.input.context);
    try {
      const input =
        f === historical
          ? {
              ...historical.input,
              authority: {
                ...historical.input.authority,
                invocation:
                  capturePluginHistoricalQueryInvocationCommitAuthority(
                    historical.input.context,
                  ),
              },
            }
          : f.input;
      const owner: PluginProjectExecutionBorrower = {
        borrow({ executionPin, authorizeBorrow }) {
          const lease = f.node.acquire({
            pluginId: executionPin.pluginId,
            packageDigest: executionPin.packageDigest,
            purpose: "newOperation",
            authorizeBorrow,
          });
          return { lease, release: () => lease.release() };
        },
      };
      // Each fixture retains its own distinct source capability and typed project publication.
      await assert.rejects(
        (
          f.bridge.executeFromBorrower as (
            borrower: PluginProjectExecutionBorrower,
            value: unknown,
          ) => Promise<unknown>
        ).call(f.bridge, owner, input),
        /plugin_node_lease_invalid/u,
      );
      assert.equal(f.state.releases, 1);
    } finally {
      dispose();
    }
  }
});
