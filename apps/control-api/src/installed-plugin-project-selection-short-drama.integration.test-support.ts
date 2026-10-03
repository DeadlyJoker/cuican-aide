import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { setImmediate, setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { ControlApiClient } from "@crewon/control-client";
import type { SelectConceptImageResponse } from "@crewon/contracts";
import {
  parseProjectGenerationSelectionHostContext,
  parseProjectGenerationSelectionUiActionRequest,
  type PluginUiJsonValue,
  type PluginUiLease,
  type ProjectGenerationSelectionHostContext,
  type ProjectGenerationSelectionUiInput,
} from "@crewon/contracts/plugins";
import type { PluginUiDefinition } from "../../../packages/plugin-sdk/src/ui-types.ts";
import type { PluginUiProps } from "../../../packages/plugin-sdk/src/sdk-types.ts";
import { productionConceptSelectionUiFixture } from "./production-project-generation-selection-plugin-runtime.test-support.ts";

export const selectImageAction =
  "crewon.project-generation-selections.v1.selectConceptImage";
export const getSelectionAction =
  "crewon.project-generation-selections.v1.getConceptSelection";

type JournalIntent = Readonly<{
  input: ProjectGenerationSelectionUiInput;
  phase: "pending" | "uncertain" | "accepted" | "refused";
  receipt: SelectConceptImageResponse | null;
  retryable: boolean;
  physicallyPending: boolean;
}>;
type Journal = Readonly<{
  current(input: {
    lease: PluginUiLease;
    input?: ProjectGenerationSelectionUiInput;
  }): JournalIntent | null;
  invoke(input: {
    lease: PluginUiLease;
    input: ProjectGenerationSelectionUiInput;
    signal: AbortSignal;
    request(signal: AbortSignal): Promise<{ output: PluginUiJsonValue }>;
  }): Promise<{ output: PluginUiJsonValue }>;
  subscribe(listener: () => void): () => void;
  invalidate(): void;
}>;

const uiDirectory = new URL(
  "../../crewon-ui/src/lib/plugins/",
  import.meta.url,
);
const journalModules = [
  "pluginUiValidation",
  "controlPluginUiSupport",
  "installedPluginProjectSelectionJournal",
] as const;
type JournalModule = Readonly<{
  create(options: {
    assertCurrent(): void;
    onDiagnostic(error: unknown): void;
  }): Journal;
  sources: readonly { path: string; sha256: string }[];
}>;
let journalCode: Promise<JournalModule> | undefined;

/** In-memory compilation of three real pure Host modules, with shared module/class identity.
 * This never builds the UI or SDK and does not copy their journal implementation. */
async function actualSelectionJournal() {
  return (journalCode ??= (async () => {
    const urls = new Map<string, string>();
    const sources: { path: string; sha256: string }[] = [];
    for (const name of journalModules) {
      const path = new URL(`${name}.ts`, uiDirectory);
      const source = await readFile(path, "utf8");
      sources.push({
        path: path.pathname,
        sha256: createHash("sha256").update(source).digest("hex"),
      });
      const compiled = ts.transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ES2022,
          isolatedModules: true,
          verbatimModuleSyntax: true,
        },
        reportDiagnostics: true,
        fileName: path.pathname,
      });
      assert.equal(
        compiled.diagnostics?.filter(
          (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
        ).length,
        0,
        `Host module did not compile: ${name}`,
      );
      const code = compiled.outputText.replace(
        /\bfrom\s+(["'])([^"']+)\1/gu,
        (_whole, _quote, specifier: string) => {
          const resolved = specifier.startsWith("./")
            ? urls.get(specifier.slice(2))
            : import.meta.resolve(specifier);
          assert.ok(resolved, `unexpected Host module dependency ${specifier}`);
          return `from ${JSON.stringify(resolved)}`;
        },
      );
      urls.set(
        name,
        `data:text/javascript;base64,${Buffer.from(`${code}\n//# sourceURL=crewon-test-host/${name}.js`).toString("base64")}`,
      );
    }
    const module = await import(
      urls.get("installedPluginProjectSelectionJournal")!
    );
    return {
      create:
        module.createInstalledPluginProjectSelectionJournal as JournalModule["create"],
      sources: Object.freeze(sources),
    };
  })());
}

export async function selectionShortDramaFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  release: Readonly<{
    packageDirectory: string;
    domModule: string;
    manifestDigest: string;
    uiDigest: string;
  }>,
) {
  const { Window } = await import(pathToFileURL(release.domModule).href);
  const browser = new Window({
    url: "https://selection.fixture.example/workspace",
    settings: {
      disableCSSFileLoading: true,
      disableJavaScriptFileLoading: true,
      disableIframePageLoading: true,
    },
  });
  const names = [
    "window",
    "document",
    "navigator",
    "location",
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
  ];
  const originals = new Map(
    names.map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  for (const name of names)
    Object.defineProperty(globalThis, name, {
      value: name === "window" ? browser : browser[name],
      writable: true,
      configurable: true,
    });
  browser.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  browser.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  const mounted = new Set<{ dispose(): Promise<void> }>();
  let supplierCalls = 0;
  browser.fetch = async () => {
    supplierCalls++;
    throw new Error("selection_fixture_must_not_contact_supplier");
  };
  t.after(async () => {
    for (const instance of mounted) await instance.dispose();
    await browser.happyDOM.close();
    for (const name of names) {
      const original = originals.get(name);
      if (original === undefined) Reflect.deleteProperty(globalThis, name);
      else Object.defineProperty(globalThis, name, original);
    }
  });
  const f = await productionConceptSelectionUiFixture(t, backend, {
    packageDirectory: release.packageDirectory,
  });
  assert.equal(f.installed.descriptor.pluginId, "crewon.short-drama");
  assert.equal(f.installed.descriptor.version, "7.0.0");
  assert.equal(f.installed.descriptor.entrypoints.node, null);
  const uiPath = f.installed.descriptor.entrypoints.ui!.path;
  for (const directory of [release.packageDirectory, f.installed.directory])
    for (const [path, digest] of [
      ["crewon.plugin.json", release.manifestDigest],
      [uiPath, release.uiDigest],
    ])
      assert.equal(
        createHash("sha256")
          .update(await readFile(join(directory, path!)))
          .digest("hex"),
        digest,
      );
  const definition: PluginUiDefinition = (
    await import(pathToFileURL(join(f.installed.directory, uiPath)).href)
  ).default;
  const host = await actualSelectionJournal();
  t.diagnostic(`actual Host source modules: ${JSON.stringify(host.sources)}`);
  let accountCurrent = true;
  const diagnostics: unknown[] = [];
  const journal = host.create({
    assertCurrent() {
      assert.ok(accountCurrent, "captured fixture account was withdrawn");
    },
    onDiagnostic: (error) => diagnostics.push(error),
  });
  t.after(() => {
    accountCurrent = false;
    journal.invalidate();
  });
  const calls: {
    action: string;
    input: PluginUiJsonValue;
    status: number;
    output?: PluginUiJsonValue;
  }[] = [];
  let dropNext = false;
  let held: Promise<void> | null = null;
  const client = new ControlApiClient({
    baseUrl: browser.location.origin,
    accessToken: f.headers.authorization.slice("Bearer ".length),
    origin: f.headers.origin,
    csrfToken: "selection-control-client-fixture-csrf",
    fetch: async (url, init) => {
      const address = new URL(String(url));
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, name) => {
        headers[name] = value;
      });
      const reply = await f.app.inject({
        method: (init?.method ?? "GET") as "GET" | "POST" | "PUT" | "DELETE",
        url: address.pathname + address.search,
        headers,
        ...(init?.body == null ? {} : { payload: String(init.body) }),
      });
      const command = init?.body == null ? null : JSON.parse(String(init.body));
      if (address.pathname.endsWith("/actions")) {
        calls.push({
          action: command.action,
          input: command.input,
          status: reply.statusCode,
          ...(reply.statusCode === 200 ? { output: reply.json().output } : {}),
        });
        if (command.action === selectImageAction && reply.statusCode === 200) {
          const gate = held;
          held = null;
          await gate;
          if (dropNext) {
            dropNext = false;
            throw new Error("fixture_dropped_confirmed_selection_response");
          }
        }
      }
      return new Response(reply.body, {
        status: reply.statusCode,
        headers: {
          "content-type": String(
            reply.headers["content-type"] ?? "application/json",
          ),
        },
      });
    },
  });
  const settle = async () => {
    await setImmediate();
    await setImmediate();
    await setImmediate();
  };
  const wait = async (check: () => boolean) => {
    const until = Date.now() + 8000;
    while (Date.now() < until) {
      if (check()) return;
      await setTimeout(10);
    }
    assert.ok(
      check(),
      `selection UI did not settle: ${JSON.stringify({ calls: calls.slice(-4), text: browser.document.body.textContent?.slice(-2000) })}`,
    );
  };
  const context = (
    lease: PluginUiLease,
  ): ProjectGenerationSelectionHostContext => {
    const intent = journal.current({ lease });
    return parseProjectGenerationSelectionHostContext({
      version: "crewon.project-generation-selection-host-context.v1",
      intent:
        intent === null
          ? null
          : {
              request: intent.input,
              phase: intent.phase,
              retryable: intent.retryable,
              receipt: intent.receipt,
            },
    });
  };
  const mount = async () => {
    const selection = await f.ledger.loadSelection({
      scope: f.state.profile,
      pluginId: f.installed.descriptor.pluginId,
    });
    assert.ok(selection);
    const lease = await client.plugins.openMount({
      pluginId: f.installed.descriptor.pluginId,
      contributionId: "workbench",
      expectedSelectionRevision: selection.revision,
      expectedPackageDigest: f.installed.packageDigest,
    });
    const asset = await f.app.inject({
      url: `/api/v1/plugins/ui/mounts/${lease.mountRef}/assets/${uiPath}`,
      headers: f.headers,
    });
    assert.equal(asset.statusCode, 200, asset.body.slice(0, 160));
    assert.equal(
      createHash("sha256").update(asset.rawPayload).digest("hex"),
      release.uiDigest,
    );
    const container: HTMLElement = browser.document.createElement("div");
    browser.document.body.append(container);
    const props = (ready: boolean): PluginUiProps => ({
      schemaVersion: "crewon.plugin-ui-props.v1",
      contributionId: "workbench",
      theme: { mode: "light", tokens: { "--text": "#202020" } },
      data: {
        locale: "zh",
        pluginUiReady: ready,
        projectGenerationSelectionContext: context(lease),
      },
    });
    const prior = calls.length;
    const instance = await definition.mount(container, props(false), {
      invoke: async (action, raw, options = {}) => {
        const signal = options.signal ?? new AbortController().signal;
        if (action === selectImageAction) {
          const parsed = parseProjectGenerationSelectionUiActionRequest({
            action,
            input: raw,
          });
          assert.equal(parsed.action, selectImageAction);
          assert.ok("idempotencyKey" in parsed.input);
          return (
            await journal.invoke({
              lease,
              input: parsed.input,
              signal,
              request: (physicalSignal) =>
                client.plugins.invoke(lease.mountRef, parsed, {
                  signal: physicalSignal,
                }),
            })
          ).output;
        }
        return (
          await client.plugins.invoke(
            lease.mountRef,
            { action, input: raw },
            { signal },
          )
        ).output;
      },
    });
    assert.equal(
      calls.length,
      prior,
      "staged actual ESM must not invoke a service",
    );
    let live = true;
    const unsubscribe = journal.subscribe(() => {
      if (live) void instance.update(props(true));
    });
    const result = {
      container,
      lease,
      button(label: string) {
        const value = Array.from(
          container.querySelectorAll<HTMLButtonElement>("button"),
        ).find((item) => item.textContent?.trim() === label);
        assert.ok(value, `missing released UI button ${label}`);
        return value;
      },
      async click(element: HTMLElement | null) {
        assert.ok(element);
        element.click();
        await settle();
      },
      async dispose() {
        if (!mounted.delete(result)) return;
        live = false;
        unsubscribe();
        instance.dispose();
        container.remove();
        await settle();
        await client.plugins.closeMount(lease.mountRef);
      },
    };
    mounted.add(result);
    await instance.update(props(true));
    if (journal.current({ lease }) === null) {
      await wait(() => container.querySelector(".project-card") !== null);
      await result.click(container.querySelector<HTMLElement>(".project-card"));
      await wait(
        () =>
          container.querySelector(".concept-panel > button.version-card") !==
          null,
      );
      await result.click(
        container.querySelector<HTMLElement>(
          ".concept-panel > button.version-card",
        ),
      );
    }
    await wait(
      () =>
        container.querySelector(
          `[data-operation-id="${f.generation.operation.operationId}"]`,
        ) !== null,
    );
    return result;
  };
  return {
    ...f,
    openHttpMount: f.mount,
    client,
    journal,
    calls,
    mount,
    wait,
    diagnostics,
    hostSources: host.sources,
    supplierCalls: () => supplierCalls,
    loseNextAcknowledgement() {
      dropNext = true;
    },
    holdNextAcknowledgement() {
      let release!: () => void;
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}
