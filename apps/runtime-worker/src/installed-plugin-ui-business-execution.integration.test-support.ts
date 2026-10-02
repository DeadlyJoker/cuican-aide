import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { TestContext } from "node:test";
import { build } from "esbuild";
import { Window } from "happy-dom";
import {
  ApplicationError,
  PluginUiApplicationService,
  PluginUiCommittedTaskAuthority,
  type PluginUiAuthorizationPort,
  type PluginUiJsonValue,
} from "@crewon/application";
import {
  parsePluginUiLease,
  type PluginUiLease,
} from "@crewon/contracts/plugins";
import type { PluginUiProps } from "@crewon/plugin-sdk/ui";
import {
  LocalPluginUiPackageReader,
  PluginExecutionRegistry,
  PluginNodeHost,
  PluginTaskActionBridge,
} from "@crewon/plugin-host";
import {
  businessExecutionFixture,
  actor,
  scope,
  digester,
} from "./installed-plugin-business-execution.integration.test-support.ts";

type BusinessFixture = Awaited<ReturnType<typeof businessExecutionFixture>>;
type UiHandle = Readonly<{
  stop(): Promise<void>;
  update(props: PluginUiProps): Promise<void>;
}>;
type Loader = Readonly<{
  mount(input: {
    root: HTMLElement;
    lease: PluginUiLease;
    props: PluginUiProps;
  }): Promise<UiHandle>;
}>;
type LoaderConstructor = new (input: {
  assetBasePath: string;
  routeStyle: "control-mount-assets";
  importer(url: string): Promise<unknown>;
  ports: {
    validateMount(lease: PluginUiLease, signal: AbortSignal): Promise<void>;
    invoke(
      lease: PluginUiLease,
      input: { action: string; input: PluginUiJsonValue; signal: AbortSignal },
    ): Promise<PluginUiJsonValue>;
    closeMount(lease: PluginUiLease): Promise<void>;
    onDiagnostic(error: unknown): void;
  };
}) => Loader;
let loaderClass: Promise<LoaderConstructor> | null = null;

/** Bundles the actual renderer loader for Node's extension resolution; it never rebuilds the SDK. */
function actualLoader(): Promise<LoaderConstructor> {
  return (loaderClass ??= (async () => {
    const result = await build({
      entryPoints: [
        fileURLToPath(
          new URL(
            "../../crewon-ui/src/lib/plugins/trustedPluginUiLoader.ts",
            import.meta.url,
          ),
        ),
      ],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      write: false,
      logLevel: "silent",
    });
    const directory = await mkdtemp(join(tmpdir(), "crewon-actual-ui-loader-"));
    try {
      const path = join(directory, "loader.mjs");
      await writeFile(path, result.outputFiles[0]!.contents);
      const imported = await import(pathToFileURL(path).href);
      return imported.TrustedPluginUiLoader as LoaderConstructor;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  })());
}

/** One actual installation/storage owner with real UI bytes, SDK mount and HTTP task dispatch. */
export async function businessUiFixture(t: TestContext, f: BusinessFixture) {
  const descriptor = f.pkg.installed.descriptor;
  assert.ok(descriptor.entrypoints.ui);
  const contribution = descriptor.contributions.find(
    (item) => item.kind === "module" && item.slot === "main.content",
  );
  assert.ok(contribution);
  const epoch = { value: "fixture-current-policy", deny: false };
  const authorization: PluginUiAuthorizationPort = {
    authorize: async ({ actor: current, resource }) => {
      assert.deepEqual(current, actor);
      assert.equal(resource.tenantId, scope.tenantId);
      assert.equal(resource.spaceId, scope.spaceId);
      assert.equal(resource.profileId, scope.profileId);
      return epoch.deny
        ? { outcome: "deny", reasonCode: "fixture_ui_revoked" }
        : { outcome: "allow", authorityEpoch: epoch.value };
    },
  };
  const profiles = { resolve: async () => scope };
  const clock = { now: () => new Date().toISOString() };
  const ids = { nextId: () => randomBytes(32).toString("base64url") };
  const committedTasks = new PluginUiCommittedTaskAuthority({
    extensions: f.extensions,
    runs: f.store,
    digester,
  });
  const bridge = new PluginTaskActionBridge({
    tasks: f.tasks,
    committedTasks,
    profiles,
    authorization,
    clock,
    ids,
    currentSelection: ({ scope: current, pluginId }) => {
      assert.deepEqual(current, scope);
      return pluginId === descriptor.pluginId ? f.currentSelection() : null;
    },
  });
  const execution = new PluginExecutionRegistry({ maximumFactories: 1 });
  const nodeHost = new PluginNodeHost({
    services: [
      bridge.hostService(),
      bridge.hostServiceV2(),
      execution.hostService(),
    ],
  });
  const closeNode = async () => {
    bridge.close();
    execution.close();
    await nodeHost.close();
  };
  let dispose: () => Promise<void> = closeNode;
  t.after(() => dispose());
  const identity = await nodeHost.activate({
    installRoot: f.pkg.input.installRoot,
    expectedPluginId: descriptor.pluginId,
    expectedPackageDigest: f.pkg.installed.packageDigest,
    authorizeActivation: ({ descriptor: candidate, packageDigest }) => {
      assert.deepEqual(candidate, descriptor);
      assert.equal(packageDigest, f.pkg.installed.packageDigest);
      return "allow";
    },
  });
  const packages = new LocalPluginUiPackageReader({
    profile: scope,
    installRoot: f.pkg.input.installRoot,
    authorizePublication: async ({
      package: installed,
      descriptor: current,
    }) => {
      assert.deepEqual(current, descriptor);
      assert.equal(installed.packageDigest, f.pkg.installed.packageDigest);
      return [descriptor.entrypoints.ui!.path];
    },
  });
  const service = new PluginUiApplicationService({
    store: f.installations,
    profiles,
    authorization,
    packages,
    actions: bridge.actions(nodeHost),
    committedTasks,
    clock,
    ids,
  });
  const requests: string[] = [];
  const committedResponses: PluginUiJsonValue[] = [];
  let loseTaskResponse = false;
  const token = randomBytes(32).toString("base64url");
  // This transport supplies one explicit test session. Every response is produced by the actual UI application.
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      const url = new URL(request.url!, "http://fixture.invalid");
      requests.push(`${request.method} ${url.pathname}`);
      const path = url.pathname;
      let output: unknown;
      if (path === "/api/v1/plugins/ui/mounts" && request.method === "POST")
        output = await service.openMount(
          actor,
          (await jsonBody(request)) as Parameters<typeof service.openMount>[1],
        );
      else {
        const match =
          /^\/api\/v1\/plugins\/ui\/mounts\/([A-Za-z0-9_-]+)(?:\/(.*))?$/u.exec(
            path,
          );
        assert.ok(match);
        const mountRef = match[1]!;
        const remainder = match[2];
        if (request.method === "GET" && remainder?.startsWith("assets/")) {
          const asset = await service.readAsset(actor, {
            mountRef,
            path: decodeURIComponent(remainder.slice(7)),
          });
          response.setHeader("content-type", asset.contentType);
          response.end(Buffer.from(asset.bytes));
          return;
        } else if (request.method === "POST" && remainder === "invoke") {
          const command = (await jsonBody(request)) as {
            action: string;
            input: PluginUiJsonValue;
          };
          output = await service.invoke(actor, { mountRef, ...command });
          committedResponses.push(output as PluginUiJsonValue);
          if (loseTaskResponse) {
            loseTaskResponse = false;
            response.destroy(new Error("fixture_task_reply_lost_after_commit"));
            return;
          }
        } else if (request.method === "GET" && remainder === undefined)
          output = await service.validateMount(actor, { mountRef });
        else if (request.method === "DELETE" && remainder === undefined) {
          await service.closeMount(actor, { mountRef });
          output = null;
        } else throw new Error("fixture_ui_route_unavailable");
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(output));
    } catch (error) {
      response.statusCode =
        error instanceof ApplicationError && error.category === "authorization"
          ? 403
          : 409;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          code: error instanceof ApplicationError ? error.code : String(error),
        }),
      );
    }
  });
  const closeServer = async () => {
    if (!server.listening) return;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  };
  dispose = async () => {
    await closeNode();
    await closeServer();
  };
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${origin}${path}`, {
      ...init,
      headers: {
        "authorization": `Bearer ${token}`,
        "content-type": "application/json",
      },
    });
    if (!response.ok)
      throw new Error(((await response.json()) as { code: string }).code);
    return response;
  };
  const outputs: PluginUiJsonValue[] = [];
  const diagnostics: unknown[] = [];
  let invoked: Promise<PluginUiJsonValue> | null = null;
  const Loader = await actualLoader();
  const loader = new Loader({
    assetBasePath: "/api/v1/plugins/ui/mounts",
    routeStyle: "control-mount-assets",
    importer: async (path) => {
      const response = await request(path);
      const bytes = await response.arrayBuffer();
      return import(
        `data:text/javascript;base64,${Buffer.from(bytes).toString("base64")}`
      );
    },
    ports: {
      validateMount: async (lease, signal) => {
        const checked = parsePluginUiLease(
          await (
            await request(`/api/v1/plugins/ui/mounts/${lease.mountRef}`, {
              signal,
            })
          ).json(),
        );
        assert.deepEqual(checked, lease);
      },
      invoke: (lease, input) => {
        invoked = (async () => {
          const result = (await (
            await request(
              `/api/v1/plugins/ui/mounts/${lease.mountRef}/invoke`,
              {
                method: "POST",
                body: JSON.stringify({
                  action: input.action,
                  input: input.input,
                }),
                signal: input.signal,
              },
            )
          ).json()) as PluginUiJsonValue;
          outputs.push(result);
          return result;
        })();
        void invoked.catch(() => {});
        return invoked;
      },
      closeMount: async (lease) => {
        await request(`/api/v1/plugins/ui/mounts/${lease.mountRef}`, {
          method: "DELETE",
        });
      },
      onDiagnostic: (error) => {
        diagnostics.push(error);
      },
    },
  });
  const window = new Window({ url: origin });
  const root = window.document.createElement("main");
  window.document.body.append(root);
  let handle: UiHandle | null = null;
  let closed = false;
  async function stop() {
    await handle?.stop();
    handle = null;
  }
  async function close() {
    if (closed) return;
    const failures: unknown[] = [];
    for (const cleanup of [
      stop,
      closeNode,
      closeServer,
      () => window.happyDOM.close(),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "fixture_ui_owner_cleanup_failed");
    closed = true;
  }
  dispose = close;
  return {
    service,
    root,
    requests,
    outputs,
    committedResponses,
    diagnostics,
    identity,
    epoch,
    stop,
    close,
    loseNextTaskResponse: () => {
      loseTaskResponse = true;
    },
    readAsset: async (lease: PluginUiLease, path: string) => {
      return (
        await request(
          `/api/v1/plugins/ui/mounts/${lease.mountRef}/assets/${path}`,
        )
      ).arrayBuffer();
    },
    async mount(input: PluginUiJsonValue) {
      const selection = f.currentSelection();
      assert.ok(selection);
      const lease = parsePluginUiLease(
        await (
          await request("/api/v1/plugins/ui/mounts", {
            method: "POST",
            body: JSON.stringify({
              pluginId: descriptor.pluginId,
              contributionId: contribution.id,
              expectedSelectionRevision: selection.revision,
              expectedPackageDigest: selection.selectedPackageDigest,
            }),
          })
        ).json(),
      );
      const props: PluginUiProps = {
        schemaVersion: "crewon.plugin-ui-props.v1",
        contributionId: contribution.id,
        theme: { mode: "light", tokens: {} },
        data: input,
      };
      if (handle !== null) await handle.stop();
      handle = await loader.mount({
        root: root as unknown as HTMLElement,
        lease,
        props,
      });
      return lease;
    },
    async update(data: PluginUiJsonValue) {
      assert.ok(
        handle,
        "mount the actual installed UI before updating its projection",
      );
      await handle.update({
        schemaVersion: "crewon.plugin-ui-props.v1",
        contributionId: contribution.id,
        theme: { mode: "light", tokens: {} },
        data,
      });
    },
    async click(selector = "button") {
      invoked = null;
      const button = root.querySelector(selector);
      assert.ok(button, "the installed UI must render its own action button");
      const output = root.querySelector("output");
      assert.ok(output, "the installed UI must render its own task receipt");
      let timer: ReturnType<typeof setTimeout>;
      let observer: InstanceType<typeof window.MutationObserver>;
      const rendered = new Promise<void>((resolve, reject) => {
        observer = new window.MutationObserver(() => resolve());
        observer.observe(output, {
          childList: true,
          subtree: true,
          characterData: true,
        });
        timer = setTimeout(
          () => reject(new Error("fixture_ui_task_receipt_timeout")),
          10_000,
        );
      });
      try {
        assert.equal(button.tagName, "BUTTON");
        (button as InstanceType<typeof window.HTMLButtonElement>).click();
        await rendered;
        assert.ok(
          invoked,
          "the installed button must invoke the real host action port",
        );
        const result = await invoked;
        assert.match(output.textContent, /任务已受理/u);
        assert.ok(output.textContent.includes(JSON.stringify(result)));
        return result;
      } finally {
        observer!.disconnect();
        clearTimeout(timer!);
      }
    },
  };
}

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    assert.ok(length <= 64 * 1024);
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
