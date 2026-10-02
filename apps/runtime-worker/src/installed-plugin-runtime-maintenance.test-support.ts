import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { PluginExecutionPackage } from "@crewon/plugin-host";
import { InstalledPluginRuntimeResolver } from "./plugins/installed-plugin-runtime-resolver.ts";
import type {
  PluginToolExecutionCommand,
  PluginToolRuntime,
  PluginToolRuntimeContext,
} from "@crewon/plugin-sdk/node";

export type ObservedRuntime = {
  runtime: PluginToolRuntime;
  context: PluginToolRuntimeContext;
  package: PluginExecutionPackage;
  commands: PluginToolExecutionCommand[];
  ackAttempts: number;
  acknowledged: number;
  scanned: number;
  closeCalls: number;
  closed: boolean;
  packageClosed: boolean;
};

/** Injects ACK interruption on the actual installed SDK factory output, never substitutes a package or proof. */
export function interruptedInstalledAcknowledgement(t: TestContext) {
  const observed: ObservedRuntime[] = [];
  const resolvers = new Set<InstalledPluginRuntimeResolver>();
  const control = { blocked: true };
  const acquireRuntime = InstalledPluginRuntimeResolver.prototype.acquire;
  t.mock.method(
    InstalledPluginRuntimeResolver.prototype,
    "acquire",
    function (
      this: InstalledPluginRuntimeResolver,
      input: Parameters<typeof acquireRuntime>[0],
    ) {
      resolvers.add(this);
      return acquireRuntime.call(this, input);
    },
  );
  const acquire = PluginExecutionPackage.prototype.acquire;
  t.mock.method(
    PluginExecutionPackage.prototype,
    "acquire",
    function (
      this: PluginExecutionPackage,
      input: Parameters<typeof acquire>[0],
    ) {
      const owner = this;
      const borrow = acquire.call(owner, input);
      return Object.freeze({
        ...borrow,
        factory: Object.freeze({
          create: async (context: PluginToolRuntimeContext) => {
            const runtime = await borrow.factory.create(context);
            const entry: ObservedRuntime = {
              runtime,
              context,
              package: owner,
              commands: [],
              ackAttempts: 0,
              acknowledged: 0,
              scanned: 0,
              closeCalls: 0,
              closed: false,
              packageClosed: false,
            };
            observed.push(entry);
            const closePackage = owner.close;
            t.mock.method(
              owner,
              "close",
              async function (this: PluginExecutionPackage) {
                await closePackage.call(this);
                entry.packageClosed = true;
              },
            );
            const execute = runtime.execute;
            t.mock.method(
              runtime,
              "execute",
              async function (
                this: PluginToolRuntime,
                ...args: Parameters<PluginToolRuntime["execute"]>
              ) {
                entry.commands.push(structuredClone(args[0]));
                return execute.apply(this, args);
              },
            );
            const acknowledge = runtime.acknowledgeExecutionResult;
            const scan = runtime.scanRetainedExecutionResults;
            const close = runtime.close;
            assert.ok(
              acknowledge && scan && close,
              "actual SDK example must expose receipt ownership and physical close",
            );
            const receiptRuntime = runtime as PluginToolRuntime &
              Required<
                Pick<
                  PluginToolRuntime,
                  | "acknowledgeExecutionResult"
                  | "scanRetainedExecutionResults"
                  | "close"
                >
              >;
            t.mock.method(
              receiptRuntime,
              "acknowledgeExecutionResult",
              function (
                this: PluginToolRuntime,
                input: Parameters<typeof acknowledge>[0],
              ) {
                entry.ackAttempts++;
                if (control.blocked) return false;
                const result = acknowledge.call(this, input);
                if (result !== false) entry.acknowledged++;
                return result;
              },
            );
            t.mock.method(
              receiptRuntime,
              "scanRetainedExecutionResults",
              function (
                this: PluginToolRuntime,
                input: Parameters<typeof scan>[0],
              ) {
                entry.scanned++;
                return scan.call(this, input);
              },
            );
            t.mock.method(
              receiptRuntime,
              "close",
              async function (this: PluginToolRuntime) {
                entry.closeCalls++;
                await close.call(this);
                entry.closed = true;
              },
            );
            return runtime;
          },
        }),
      });
    },
  );
  return { control, observed, resolvers };
}

export function externalInstalledPackage() {
  const packageDirectory = process.env.CREWON_TEST_BUSINESS_PLUGIN_V1_DIR;
  assert.ok(
    packageDirectory,
    "Worker example bootstrap must build the actual SDK package before consumers run",
  );
  return { packageDirectory };
}

export async function tick() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

export async function until(operation: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    if (await operation()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("installed_maintenance_fixture_did_not_settle");
}
