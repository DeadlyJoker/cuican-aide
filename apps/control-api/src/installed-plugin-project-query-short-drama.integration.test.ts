import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate, setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  parseProjectGenerationQueryUiActionRequest,
  parseProjectGenerationQueryUiActionResponse,
  type PluginUiJsonValue,
  type ProjectGenerationQueryHostContext,
} from "@crewon/contracts/plugins";
import { installedProjectQueryHttpFixture } from "./installed-plugin-project-query-http.test-support.ts";
import {
  queryAction,
  creditScope,
} from "./installed-plugin-project-query-owner.test-support.ts";

const packageDirectory =
  process.env.CREWON_SHORT_DRAMA_QUERY_TEST_PACKAGE_DIRECTORY;
const domModule = process.env.CREWON_HAPPY_DOM_MODULE;
const expectedManifestDigest =
  "47afceb5e3da897d5adea9250d94682cd44b9e9e0aecbd8f2bb28e1fdf2e0652";
const expectedUiDigest =
  "6b528d780c935fec3a252f925dc949f501e2ed696d9b36371d26d94e9c1991bf";

async function settle() {
  await setImmediate();
  await setImmediate();
  await setImmediate();
}

/** Actual released ESM/registered HTTP/Node/SQL/receipt chain. DOM, identity, PDP, peer and funded history are fixtures. */
async function releasedQueryFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
) {
  const { Window } = await import(pathToFileURL(domModule!).href);
  const browser = new Window({
    url: "https://query.fixture.example/workspace",
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
  let supplierCalls = 0;
  browser.fetch = async () => {
    supplierCalls++;
    throw new Error("query_fixture_must_not_contact_supplier");
  };
  const mounted = new Set<{ dispose(): Promise<void> }>();
  t.after(async () => {
    for (const instance of mounted) await instance.dispose();
    await browser.happyDOM.close();
    for (const name of names) {
      const original = originals.get(name);
      if (original === undefined) Reflect.deleteProperty(globalThis, name);
      else Object.defineProperty(globalThis, name, original);
    }
  });
  const f = await installedProjectQueryHttpFixture(t, backend, {
    packageDirectory: packageDirectory!,
  });
  assert.equal(f.source.descriptor.pluginId, "crewon.short-drama");
  assert.equal(f.source.descriptor.version, "6.0.0");
  assert.equal(f.source.descriptor.entrypoints.node, null);
  const uiPath = f.source.descriptor.entrypoints.ui!.path;
  const uiDigest = f.source.descriptor.files.find(
    (file) => file.path === uiPath,
  )!.sha256;
  const manifestDigest = createHash("sha256")
    .update(await readFile(join(packageDirectory!, "crewon.plugin.json")))
    .digest("hex");
  assert.equal(manifestDigest, expectedManifestDigest);
  assert.equal(uiDigest, expectedUiDigest);
  assert.equal(
    createHash("sha256")
      .update(await readFile(join(f.source.directory, "crewon.plugin.json")))
      .digest("hex"),
    manifestDigest,
  );
  assert.equal(
    createHash("sha256")
      .update(await readFile(join(f.source.directory, uiPath)))
      .digest("hex"),
    uiDigest,
  );
  const definition = (
    await import(pathToFileURL(join(f.source.directory, uiPath)).href)
  ).default;
  const calls: {
    action: string;
    input: PluginUiJsonValue;
    status: number;
    output?: PluginUiJsonValue;
  }[] = [];
  let dropNextAcknowledgement = false;
  const props = (
    ready: boolean,
    intent: ProjectGenerationQueryHostContext["intent"] = null,
  ) => ({
    schemaVersion: "crewon.plugin-ui-props.v1",
    contributionId: "workbench",
    theme: { mode: "light", tokens: { "--text": "#202020" } },
    data: {
      locale: "zh",
      pluginUiReady: ready,
      projectGenerationQueryContext: {
        version: "crewon.project-generation-query-host-context.v1",
        phase: "ready",
        thread: {
          threadId: f.request.threadId,
          revision:
            intent?.receipt?.threadRevision ?? f.request.expectedThreadRevision,
          provisional: false,
        },
        threadReady:
          intent?.phase !== "pending" && intent?.phase !== "uncertain",
        intent,
      },
    },
  });
  const wait = async (check: () => boolean) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (check()) return;
      await setTimeout(10);
    }
    assert.ok(
      check(),
      `released UI did not settle: ${JSON.stringify({ calls: calls.slice(-4), text: browser.document.body.textContent?.slice(-1600) })}`,
    );
  };
  const mount = async (
    intent: ProjectGenerationQueryHostContext["intent"] = null,
  ) => {
    const selected = await f.ledger.loadSelection({
      scope: f.profile,
      pluginId: f.sourceId,
    });
    assert.ok(selected);
    const opened = await f.app.inject({
      method: "POST",
      url: "/api/v1/plugins/ui/mounts",
      headers: f.headers,
      payload: {
        pluginId: f.sourceId,
        contributionId: "workbench",
        expectedSelectionRevision: selected.revision,
        expectedPackageDigest: f.source.packageDigest,
      },
    });
    assert.equal(opened.statusCode, 200, opened.body);
    const lease = opened.json<{ mountRef: string }>();
    const asset = await f.app.inject({
      method: "GET",
      url: `/api/v1/plugins/ui/mounts/${lease.mountRef}/assets/${uiPath}`,
      headers: f.headers,
    });
    assert.equal(asset.statusCode, 200, asset.body.slice(0, 100));
    assert.equal(
      createHash("sha256").update(asset.rawPayload).digest("hex"),
      uiDigest,
    );
    const container: HTMLElement = browser.document.createElement("div");
    browser.document.body.append(container);
    const prior = calls.length;
    const instance = definition.mount(container, props(false, intent), {
      invoke: async (
        action: string,
        input: PluginUiJsonValue,
        options: { signal?: AbortSignal } = {},
      ) => {
        options.signal?.throwIfAborted();
        const captured = structuredClone(input);
        const reply = await f.app.inject({
          method: "POST",
          url: `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
          headers: f.headers,
          payload: { action, input: captured },
        });
        const output =
          reply.statusCode === 200 ? reply.json().output : undefined;
        calls.push({
          action,
          input: captured,
          status: reply.statusCode,
          output,
        });
        if (reply.statusCode !== 200)
          throw Object.assign(new Error(reply.json().error.code), {
            category: reply.json().error.category,
          });
        if (action === queryAction && dropNextAcknowledgement) {
          dropNextAcknowledgement = false;
          throw new Error("fixture_dropped_confirmed_query_acknowledgement");
        }
        options.signal?.throwIfAborted();
        return output;
      },
    });
    assert.equal(
      calls.length,
      prior,
      "staged released module must not invoke services",
    );
    const button = (label: string) => {
      const value = Array.from(container.querySelectorAll("button")).find(
        (item) => item.textContent?.trim() === label,
      );
      assert.ok(value, `missing released UI button ${label}`);
      return value;
    };
    const result = {
      container,
      lease,
      button,
      async click(element: HTMLElement | null) {
        assert.ok(element);
        element.click();
        await settle();
      },
      async dispose() {
        if (!mounted.delete(result)) return;
        instance.dispose();
        container.remove();
        await settle();
        const reply = await f.app.inject({
          method: "DELETE",
          url: `/api/v1/plugins/ui/mounts/${lease.mountRef}`,
          headers: f.headers,
        });
        assert.equal(reply.statusCode, 200, reply.body);
      },
    };
    mounted.add(result);
    instance.update(props(true, intent));
    if (intent === null) {
      await wait(() => container.querySelector(".project-card") !== null);
      await result.click(container.querySelector<HTMLElement>(".project-card"));
      await wait(() =>
        Array.from(
          container.querySelectorAll(".concept-panel > button.version-card"),
        ).some(
          (item) =>
            item.querySelector("strong")?.textContent === f.concept.asset.name,
        ),
      );
      await result.click(
        Array.from(
          container.querySelectorAll<HTMLElement>(
            ".concept-panel > button.version-card",
          ),
        ).find(
          (item) =>
            item.querySelector("strong")?.textContent === f.concept.asset.name,
        )!,
      );
    }
    await wait(
      () =>
        container.querySelector(
          `[data-operation-id="${f.operationId}"] button`,
        ) !== null,
    );
    return result;
  };
  const latest = () => {
    const call = calls
      .filter((entry) => entry.action === queryAction && entry.status === 200)
      .at(-1);
    assert.ok(call);
    const request = parseProjectGenerationQueryUiActionRequest({
      action: queryAction,
      input: call.input,
    });
    return {
      request: request.input,
      receipt: parseProjectGenerationQueryUiActionResponse(
        request,
        call.output,
      ),
    };
  };
  return {
    ...f,
    calls,
    mount,
    wait,
    latest,
    loseNextAcknowledgement() {
      dropNextAcknowledgement = true;
    },
    supplierCalls: () => supplierCalls,
  };
}

for (const backend of ["sqlite", "postgres"] as const)
  test(
    `${backend} released short-drama 6 ESM explicitly queries an original operation through registered HTTP/Node B/SQL and retries UNKNOWN after remount without another Run or charge`,
    {
      skip:
        !packageDirectory ||
        !domModule ||
        (backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL),
      timeout: 60_000,
    },
    async (t) => {
      const f = await releasedQueryFixture(t, backend);
      const before = await f.counts(),
        account = await f.credits.getAccount(creditScope),
        quoteCalls = f.nodeState.quoteCalls;
      const ui = await f.mount();
      assert.equal(
        f.calls.filter((call) => call.action === queryAction).length,
        0,
      );
      assert.deepEqual(await f.counts(), before);
      f.loseNextAcknowledgement();
      const operationButton = ui.container.querySelector<HTMLButtonElement>(
        `[data-operation-id="${f.operationId}"] button`,
      )!;
      assert.equal(operationButton.disabled, false);
      await ui.click(operationButton);
      await f.wait(
        () =>
          ui.container
            .querySelector('[aria-label="原任务查询"]')
            ?.textContent?.includes("查询尚未确认") === true,
      );
      const accepted = f.latest();
      assert.equal(accepted.receipt.disposition, "committed");
      assert.deepEqual(accepted.request.reference, f.reference);
      assert.equal(accepted.request.operationId, f.operationId);
      assert.equal(accepted.request.threadId, f.request.threadId);
      assert.equal(accepted.request.expectedThreadRevision, 1);
      assert.doesNotMatch(
        JSON.stringify(accepted.request),
        /sourceRunId|actor|payer|prompt|target|tenant|space|expectedProjectRevision/u,
      );
      const saved = await f.extensions.loadProjectQueryLink({
        tenantId: f.generation.binding.tenantId,
        spaceId: f.generation.binding.spaceId,
        runId: accepted.receipt.runId,
      });
      assert.ok(saved);
      assert.equal(saved.sourcePin.pluginId, "crewon.short-drama");
      assert.equal(saved.sourcePin.version, "6.0.0");
      assert.equal(saved.sourcePin.packageDigest, f.source.packageDigest);
      assert.equal(saved.executionPin.version, "0.2.0");
      assert.equal(saved.executionPin.packageDigest, f.target.packageDigest);
      assert.equal(saved.generationLinkDigest, f.generationLink.contentDigest);
      assert.equal(
        ui.container.querySelector<HTMLElement>(
          '[aria-label="已保存输入的生成记录"]',
        )?.dataset.runId,
        f.generation.binding.runId,
      );
      const after = await f.counts();
      for (const table of [
        "run_snapshots",
        "plugin_query_task_admissions",
        "creative_project_query_links",
      ])
        assert.equal(after[table], before[table]! + 1, table);
      for (const table of [
        "creative_project_generation_links",
        "plugin_task_admissions",
        "extension_credit_admissions",
        "plugin_credit_reservations",
        "plugin_credit_entries",
      ])
        assert.equal(after[table], before[table], table);
      assert.deepEqual(await f.credits.getAccount(creditScope), account);
      assert.equal(f.nodeState.quoteCalls, quoteCalls);
      await ui.dispose();
      const count = f.calls.filter(
        (call) => call.action === queryAction,
      ).length;
      const restored = await f.mount({
        request: accepted.request,
        phase: "uncertain",
        retryable: true,
        receipt: null,
      });
      assert.equal(
        f.calls.filter((call) => call.action === queryAction).length,
        count,
      );
      await f.wait(() => !restored.button("重试原查询").disabled);
      await restored.click(restored.button("重试原查询"));
      await f.wait(
        () =>
          restored.container.querySelector<HTMLElement>(
            '[aria-label="原任务查询"]',
          )?.dataset.queryRunId === accepted.receipt.runId,
      );
      const replay = f.latest();
      assert.deepEqual(replay.request, accepted.request);
      assert.deepEqual(replay.receipt, {
        ...accepted.receipt,
        disposition: "replayed",
      });
      await f.wait(
        () =>
          restored.container.querySelector<HTMLElement>(
            '[aria-label="已保存输入的生成记录"]',
          )?.dataset.runId === f.generation.binding.runId,
      );
      assert.equal(
        restored.container.querySelector<HTMLElement>(
          '[aria-label="已保存输入的生成记录"]',
        )?.dataset.runId,
        f.generation.binding.runId,
      );
      assert.deepEqual(await f.counts(), after);
      assert.deepEqual(await f.credits.getAccount(creditScope), account);
      assert.equal(f.nodeState.quoteCalls, quoteCalls);
      assert.equal(f.supplierCalls(), 0);
      assert.equal(
        f.calls.filter((call) =>
          call.action.startsWith("crewon.project-generations."),
        ).length,
        0,
      );
      assert.equal(
        f.state.lastContext,
        null,
        "original HTTP registered invocation remains the source context",
      );
      await restored.dispose();
    },
  );
