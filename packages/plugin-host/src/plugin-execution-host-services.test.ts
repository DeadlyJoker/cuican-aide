import assert from "node:assert/strict";
import test from "node:test";
import { PluginExecutionPackage } from "./plugin-execution-package.ts";
import {
  executionContext,
  executionPackage,
  runtimeSource,
} from "./plugin-execution-registry.test-support.ts";
import { allowPreparedCommit } from "./plugin-node-preparation.test-support.ts";

const requirement = {
  service: "host.project-tools",
  apiVersion: "1",
  optional: false,
};
const historical = {
  purpose: "historicalOperation" as const,
  authorizeBorrow: () => "allow" as const,
};
const setup = `const project=ctx.services.get('host.project-tools','1');
ctx.services.get('crewon.execution','1').register({create(input){
 if(project.identity!==input.identity.packageDigest)throw new Error('foreign-bound-service');
 record('bound:'+project.identity);return ${runtimeSource};}});`;

test("execution packages bind explicit services to the actual installed identity and join disposal", async (t) => {
  const installed = await executionPackage(t, {
    requires: [requirement],
    setup,
  });
  let disposed = 0,
    entered!: () => void,
    release!: () => void;
  const enteredDisposal = new Promise<void>((done) => {
    entered = done;
  });
  const disposal = new Promise<void>((done) => {
    release = done;
  });
  const owner = await PluginExecutionPackage.open({
    activation: installed,
    commit: allowPreparedCommit,
    hostServices: [
      {
        service: requirement.service,
        apiVersion: "1",
        value: Object.freeze({}),
        bindForPlugin(identity, lifetime) {
          assert.equal(identity.pluginId, installed.expectedPluginId);
          assert.equal(identity.packageDigest, installed.expectedPackageDigest);
          assert.equal(Object.isFrozen(identity), true);
          lifetime.onDispose(async () => {
            entered();
            await disposal;
            disposed++;
          });
          return Object.freeze({ identity: identity.packageDigest });
        },
      },
    ],
  });
  t.after(async () => {
    release();
    await owner.close();
  });
  const borrow = owner.acquire(historical),
    runtime = await borrow.factory.create(executionContext(borrow.identity));
  await runtime.close?.();
  borrow.release();
  let finished = false;
  const closing = owner.close().then(() => {
    finished = true;
  });
  await enteredDisposal;
  assert.equal(finished, false);
  assert.equal(disposed, 0);
  assert.throws(
    () => owner.acquire(historical),
    /plugin_execution_package_closed/u,
  );
  release();
  await closing;
  assert.equal(disposed, 1);
});
test("required service omission, wrong versions and undeclared access do not run a factory", async (t) => {
  const installed = await executionPackage(t, {
    requires: [requirement],
    setup,
  });
  for (const hostServices of [
    undefined,
    [{ service: requirement.service, apiVersion: "2", value: {} }],
  ]) {
    await assert.rejects(
      PluginExecutionPackage.open({
        activation: installed,
        commit: allowPreparedCommit,
        ...(hostServices === undefined ? {} : { hostServices }),
      }),
      /plugin_dependency_unavailable/u,
    );
  }
  assert.deepEqual(await installed.records(), []);
  const undeclared = await executionPackage(t, { setup });
  await assert.rejects(
    PluginExecutionPackage.open({
      activation: undeclared,
      commit: allowPreparedCommit,
      hostServices: [
        {
          service: requirement.service,
          apiVersion: "1",
          value: { identity: "unused" },
        },
      ],
    }),
    /plugin_dependency_undeclared/u,
  );
  assert.equal(
    (await undeclared.records()).some((line) => line.startsWith("bound:")),
    false,
  );
});
test("a service binding failure cleans the unpublished package without borrowing another host", async (t) => {
  const installed = await executionPackage(t, {
    requires: [requirement],
    setup,
  });
  let disposed = 0,
    committed = 0;
  await assert.rejects(
    PluginExecutionPackage.open({
      activation: installed,
      commit: {
        authorizeCommit() {
          committed++;
          return "allow";
        },
      },
      hostServices: [
        {
          service: requirement.service,
          apiVersion: "1",
          value: {},
          bindForPlugin(_identity, lifetime) {
            lifetime.onDispose(() => {
              disposed++;
            });
            throw new Error("owned_binding_failure");
          },
        },
      ],
    }),
    /plugin_host_service_binding_failed/u,
  );
  assert.equal(disposed, 1);
  assert.equal(committed, 0);
});
test("host service limits and execution service conflicts fail closed", async (t) => {
  const installed = await executionPackage(t);
  await assert.rejects(
    PluginExecutionPackage.open({
      activation: installed,
      commit: allowPreparedCommit,
      hostServices: Array.from({ length: 1024 }, () => ({
        service: "host.extra",
        apiVersion: "1",
        value: {},
      })),
    }),
    /plugin_execution_host_services_invalid/u,
  );
  await assert.rejects(
    PluginExecutionPackage.open({
      activation: installed,
      commit: allowPreparedCommit,
      hostServices: [
        { service: "crewon.execution", apiVersion: "1", value: {} },
      ],
    }),
    /plugin_service_conflict/u,
  );
  assert.deepEqual(await installed.records(), []);
});
