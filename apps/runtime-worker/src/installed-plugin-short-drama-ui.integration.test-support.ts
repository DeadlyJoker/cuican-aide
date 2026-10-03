import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { TestContext } from "node:test";
import { build } from "esbuild";
import { Window } from "happy-dom";
import {
  ApplicationError,
  PluginUiApplicationService,
  type PluginUiJsonValue,
} from "@crewon/application";
import {
  parsePluginUiLease,
  type PluginUiLease,
} from "@crewon/contracts/plugins";
import {
  parseInstalledPluginPackage,
  parsePluginSelection,
} from "@crewon/domain";
import {
  installLocalPluginPackage,
  LocalPluginUiPackageReader,
} from "@crewon/plugin-host";
import type { PluginUiProps } from "@crewon/plugin-sdk/ui";
import {
  actor,
  scope,
  fixture as installationFixture,
  type Backend,
} from "../../../packages/store/src/plugin-installation-store.test-support.ts";

type UiHandle = Readonly<{
  update(props: PluginUiProps): Promise<void>;
  stop(): Promise<void>;
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

// Compile only the real renderer loader for Node's TS resolution, never the SDK or plugin bundle.
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
    const directory = await mkdtemp(
      join(tmpdir(), "crewon-short-drama-ui-loader-"),
    );
    try {
      const path = join(directory, "loader.mjs");
      await writeFile(path, result.outputFiles[0]!.contents);
      return (await import(pathToFileURL(path).href))
        .TrustedPluginUiLoader as LoaderConstructor;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  })());
}

export const shortDramaProps = (
  tokens: Readonly<Record<string, string>> = { "--text": "#202020" },
  mode: "light" | "dark" = "light",
): PluginUiProps => ({
  schemaVersion: "crewon.plugin-ui-props.v1",
  contributionId: "workbench",
  theme: { mode, tokens },
  data: { locale: "zh", shortDramaPreview: true },
});

export async function settleShortDrama() {
  await setImmediate();
  await setImmediate();
  await setImmediate();
}

/** Real installed UI and two real database connections; no Node Host, task authority or provider. */
export async function shortDramaUiFixture(t: TestContext, backend: Backend) {
  const source = process.env.CREWON_TEST_SHORT_DRAMA_PLUGIN_V1_DIR;
  const upgradeSource = process.env.CREWON_TEST_SHORT_DRAMA_PLUGIN_V2_DIR;
  assert.ok(
    source,
    "official producer must provide the externally built short-drama v1 package",
  );
  assert.ok(
    upgradeSource,
    "official producer must provide the externally built short-drama v2 package",
  );
  let cleanup: () => Promise<void> = async () => {};
  t.after(() => cleanup());
  const database = await installationFixture(t, backend);
  const parent = database.first.parent;
  await parent.extensionStore().migrate();
  await parent.extensionStore().migrateCredits();
  await parent.pluginCreditStore().migrate();
  await parent.externalOperationStore().migrate();
  const directory = await mkdtemp(
    join(tmpdir(), "crewon-short-drama-installed-ui-"),
  );
  const installRoot = join(directory, "installed");
  await mkdir(installRoot, { mode: 0o700 });
  cleanup = async () => {
    await writableTree(directory);
    await rm(directory, { recursive: true, force: true });
  };
  const installed = await installLocalPluginPackage({
    directory: source,
    installRoot,
    authorization: async () => ({ outcome: "allow" }),
  });
  const descriptor = installed.descriptor;
  assert.equal(descriptor.pluginId, "crewon.short-drama");
  assert.equal(descriptor.version, "1.0.0");
  assert.equal(descriptor.entrypoints.node, null);
  assert.equal(descriptor.businessManifestPath, null);
  assert.deepEqual(descriptor.requires, []);
  assert.deepEqual(descriptor.provides, []);
  const at = new Date().toISOString();
  const store = database.first.store;
  const receipt = (key: string) => ({
    idempotencyKey: key,
    requestDigest: `sha256:${createHash("sha256").update(key).digest("hex")}`,
  });
  const record = (value: typeof installed) =>
    parseInstalledPluginPackage({
      schemaVersion: "crewon.installed-plugin-package.v1",
      ...scope,
      pluginId: value.descriptor.pluginId,
      publisherId: value.descriptor.publisherId,
      version: value.descriptor.version,
      packageDigest: value.packageDigest,
      installedAt: at,
      installedByPrincipalId: actor.principalId,
      installedByActorId: actor.actorId,
    });
  const saved = await store.recordInstalledPackage({
    scope,
    actor,
    receipt: receipt("install-v1"),
    package: record(installed),
    expectedSelectionRevision: null,
  });
  let selection = saved.selection;
  async function select(
    state: "enabled" | "disabled",
    packageDigest = selection.selectedPackageDigest!,
  ) {
    const key = `select-${selection.revision + 1}`;
    selection = (
      await store.commitSelection({
        scope,
        actor,
        receipt: receipt(key),
        expectedSelectionRevision: selection.revision,
        selection: parsePluginSelection({
          ...selection,
          revision: selection.revision + 1,
          state,
          selectedPackageDigest: packageDigest,
          updatedAt: at,
          updatedByPrincipalId: actor.principalId,
          updatedByActorId: actor.actorId,
        }),
      })
    ).selection;
  }
  await select("enabled");
  const packages = new Map([[installed.packageDigest, installed]]);
  const readAssets: string[] = [];
  const imports: string[] = [];
  const diagnostics: unknown[] = [];
  let invokeCalls = 0;
  let fetchCalls = 0;
  const window = new Window({ url: "https://crewon-fixture.test/workspace" });
  const globals = globalThis as unknown as Record<string, unknown>;
  const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
  for (const name of [
    "window",
    "document",
    "navigator",
    "Node",
    "Element",
    "HTMLElement",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "HTMLDialogElement",
    "Event",
    "MouseEvent",
    "KeyboardEvent",
    "MutationObserver",
  ]) {
    originalGlobals.set(
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    );
    Object.defineProperty(globalThis, name, {
      value:
        name === "window"
          ? window
          : (window as unknown as Record<string, unknown>)[name],
      writable: true,
      configurable: true,
    });
  }
  const closedDialogs: unknown[] = [];
  // HappyDOM does not model the browser top layer; this adapter records actual dialog ownership.
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  window.HTMLDialogElement.prototype.close = function () {
    if (this.open) closedDialogs.push(this);
    this.open = false;
  };
  const noticeTimers = new Set<ReturnType<typeof setTimeout>>();
  const originalTimeout = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const originalFetch = globalThis.fetch;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const timer = originalTimeout(...args);
    if (args[1] === 4000) noticeTimers.add(timer);
    return timer;
  }) as typeof setTimeout;
  globalThis.clearTimeout = (timer) => {
    noticeTimers.delete(timer as ReturnType<typeof setTimeout>);
    return originalClear(timer);
  };
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("short_drama_demo_must_not_fetch");
  };
  const restore = () => {
    globalThis.setTimeout = originalTimeout;
    globalThis.clearTimeout = originalClear;
    globalThis.fetch = originalFetch;
    for (const [name, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globals[name];
    }
  };
  cleanup = async () => {
    try {
      await window.happyDOM.close();
    } finally {
      restore();
      await writableTree(directory);
      await rm(directory, { recursive: true, force: true });
    }
  };
  const root = window.document.createElement("main");
  const account = window.document.createElement("aside");
  account.className = "original-account-and-navigation";
  account.textContent = "原用户栏与设置";
  window.document.documentElement.dataset.theme = "host-theme";
  window.document.documentElement.style.setProperty("--text", "host-authority");
  window.document.body.append(account, root);
  const hostRootStyle = window.document.documentElement.getAttribute("style");
  const service = new PluginUiApplicationService({
    store,
    profiles: { resolve: async () => scope },
    authorization: {
      authorize: async (input) => {
        assert.deepEqual(input.actor, actor);
        assert.equal(input.resource.tenantId, scope.tenantId);
        assert.equal(input.resource.spaceId, scope.spaceId);
        assert.equal(input.resource.profileId, scope.profileId);
        return {
          outcome: "allow",
          authorityEpoch: "short-drama-explicit-test-authority",
        };
      },
    },
    packages: new LocalPluginUiPackageReader({
      profile: scope,
      installRoot,
      authorizePublication: async (input) => {
        assert.ok(packages.has(input.package.packageDigest));
        return input.descriptor.files
          .filter((file) => /\.(?:mjs|png)$/u.test(file.path))
          .map((file) => file.path);
      },
    }),
    actions: {
      invoke: async () => {
        invokeCalls += 1;
        throw new Error("short_drama_ui_has_no_actions");
      },
    },
    ids: { nextId: () => randomBytes(32).toString("base64url") },
    clock: { now: () => new Date().toISOString() },
  });
  let handle: UiHandle | null = null;
  let latestLease: PluginUiLease | null = null;
  async function stop() {
    await handle?.stop();
    handle = null;
  }
  let closed = false;
  cleanup = async () => {
    if (closed) return;
    try {
      await stop();
      await settleShortDrama();
      await window.happyDOM.close();
    } finally {
      restore();
      await writableTree(directory);
      await rm(directory, { recursive: true, force: true });
      closed = true;
    }
  };
  const Loader = await actualLoader();
  const loader = new Loader({
    assetBasePath: "/api/v1/plugins/ui/mounts",
    routeStyle: "control-mount-assets",
    importer: async (url) => {
      assert.ok(latestLease);
      const entry = latestLease.descriptor.entrypoints.ui;
      assert.ok(entry);
      assert.equal(
        url,
        `/api/v1/plugins/ui/mounts/${latestLease.mountRef}/assets/${entry.path}`,
      );
      const asset = await service.readAsset(actor, {
        mountRef: latestLease.mountRef,
        path: entry.path,
      });
      readAssets.push(entry.path);
      const current = packages.get(latestLease.packageDigest);
      assert.ok(current);
      const path = join(current.directory, entry.path);
      assert.deepEqual(Buffer.from(asset.bytes), await readFile(path));
      const fileUrl = pathToFileURL(path).href;
      imports.push(fileUrl);
      // Import the verified installed artifact, preserving its relative import.meta.url PNG reference.
      return import(fileUrl);
    },
    ports: {
      validateMount: async (lease, signal) => {
        signal.throwIfAborted();
        assert.deepEqual(
          await service.validateMount(actor, { mountRef: lease.mountRef }),
          lease,
        );
        signal.throwIfAborted();
      },
      invoke: async (lease, input) =>
        service.invoke(actor, {
          mountRef: lease.mountRef,
          action: input.action,
          input: input.input,
        }),
      closeMount: async (lease) => {
        try {
          await service.closeMount(actor, { mountRef: lease.mountRef });
        } catch (error) {
          // Match the real Control DELETE route: a lease already revoked by its read fence is closed.
          if (
            !(error instanceof ApplicationError) ||
            error.category !== "notFound" ||
            error.code !== "plugin_ui_mount_unavailable"
          )
            throw error;
        }
      },
      onDiagnostic: (error) => {
        diagnostics.push(error);
      },
    },
  });
  const openCommand = () => ({
    pluginId: descriptor.pluginId,
    contributionId: "workbench",
    expectedSelectionRevision: selection.revision,
    expectedPackageDigest: selection.selectedPackageDigest!,
  });
  async function mount(props = shortDramaProps()) {
    await stop();
    latestLease = parsePluginUiLease(
      await service.openMount(actor, openCommand()),
    );
    handle = await loader.mount({
      root: root as unknown as HTMLElement,
      lease: latestLease,
      props,
    });
    await settleShortDrama();
    return latestLease;
  }
  async function snapshot() {
    const names = await database.tableNames();
    const rows: Record<string, readonly Record<string, unknown>[]> = {};
    for (const name of names) {
      assert.match(name, /^[a-z_]+$/u);
      rows[name] = (
        await database.query(`SELECT * FROM ${database.prefix}"${name}"`)
      ).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    return rows;
  }
  const before = await snapshot();
  return {
    installed,
    descriptor,
    root,
    window,
    account,
    hostRootStyle,
    service,
    openCommand,
    readAssets,
    imports,
    diagnostics,
    closedDialogs,
    noticeTimers,
    mount,
    stop,
    snapshot,
    async assertNoExecutionWrites(expected = before) {
      assert.equal(invokeCalls, 0);
      assert.equal(fetchCalls, 0);
      assert.deepEqual(
        await snapshot(),
        expected,
        "UI-only demo changes no durable installation, Run, operation or credit rows",
      );
      for (const table of [
        "run_snapshots",
        "extension_run_bindings",
        "plugin_task_admissions",
        "plugin_credit_accounts",
        "plugin_credit_reservations",
        "plugin_credit_entries",
        "extension_credit_admissions",
        "extension_external_operations",
      ])
        if (table in before) assert.equal(before[table]!.length, 0, table);
      assert.equal(account.textContent, "原用户栏与设置");
      assert.equal(account.isConnected, true);
      assert.equal(window.document.documentElement.dataset.theme, "host-theme");
      assert.equal(
        window.document.documentElement.getAttribute("style"),
        hostRootStyle,
      );
    },
    async update(props: PluginUiProps) {
      assert.ok(handle);
      await handle.update(props);
      await settleShortDrama();
    },
    async upgrade() {
      const next = await installLocalPluginPackage({
        directory: upgradeSource,
        installRoot,
        authorization: async () => ({ outcome: "allow" }),
      });
      assert.equal(next.descriptor.version, "2.0.0");
      assert.notEqual(next.packageDigest, installed.packageDigest);
      packages.set(next.packageDigest, next);
      await store.recordInstalledPackage({
        scope,
        actor,
        receipt: receipt("install-v2"),
        package: record(next),
        expectedSelectionRevision: selection.revision,
      });
      await select("enabled", next.packageDigest);
      return next;
    },
    disable: () => select("disabled"),
    async readAsset(lease: PluginUiLease, path: string) {
      const result = await service.readAsset(actor, {
        mountRef: lease.mountRef,
        path,
      });
      readAssets.push(path);
      return result;
    },
    button(label: string) {
      const found = [...root.querySelectorAll("button")].find(
        (item) => item.textContent.trim() === label,
      );
      assert.ok(found, `missing installed short-drama button: ${label}`);
      return found;
    },
    async click(element: { click(): void } | null) {
      assert.ok(element);
      element.click();
      await settleShortDrama();
    },
    async input(
      element:
        | InstanceType<typeof window.HTMLInputElement>
        | InstanceType<typeof window.HTMLTextAreaElement>
        | null,
      value: string,
    ) {
      assert.ok(element);
      const prototype =
        element instanceof window.HTMLTextAreaElement
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
        element,
        value,
      );
      element.dispatchEvent(new window.Event("input", { bubbles: true }));
      element.dispatchEvent(new window.Event("change", { bubbles: true }));
      await settleShortDrama();
    },
  };
}

async function writableTree(path: string): Promise<void> {
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) return;
  await chmod(path, 0o700);
  for (const entry of await readdir(path))
    await writableTree(join(path, entry));
}
