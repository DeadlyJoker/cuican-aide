// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { InstalledPluginModule } from "./InstalledPluginModule";
import { createControlPluginUiHost } from "../../lib/plugins/controlPluginUiHost";
import {
  controlUiClient,
  controlUiItem,
  controlUiResponse,
} from "../../lib/plugins/controlPluginUi.test-support";
import { taskContextFixture } from "../../lib/plugins/installedPluginTaskContext.test-support";
import {
  deferred,
  uiHarness,
  uiLease,
} from "../../lib/plugins/pluginUiLoader.test-support";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
const containers: HTMLElement[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  for (const container of containers.splice(0)) container.remove();
});
/** Actual Host mount/client/task hook with named portable module and HTTP response fixtures. */
function fixture(conversationService: string | null = null, apiVersion = "1") {
  const h = uiHarness();
  const original = uiLease();
  const lease = {
    ...original,
    descriptor: {
      ...original.descriptor,
      requires: [
        { service: "crewon.tasks", apiVersion: "1", optional: true },
        ...(conversationService
          ? [{ service: conversationService, apiVersion, optional: true }]
          : []),
      ],
    },
  };
  let gate: ReturnType<typeof deferred<Response>> | null = null;
  const wire = controlUiClient((_url, init) => {
    if (init.method === "DELETE") return controlUiResponse({ closed: true });
    if (init.method === "POST" && gate) return gate.promise;
    return controlUiResponse(lease);
  });
  const host = createControlPluginUiHost({
    client: wire.client,
    assertCurrent: () => undefined,
    importer: async () => ({ default: h.definition }),
    onDiagnostic: vi.fn(),
  });
  const module = {
    key: JSON.stringify([lease.descriptor.pluginId, lease.contributionId]),
    mountKey: "named-legacy-module-mount",
    title: "Legacy task projection consumer",
    contributionId: lease.contributionId,
    plugin: controlUiItem(lease),
  };
  const task = taskContextFixture();
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const open = vi.fn();
  const render = (options: { active?: boolean; ports?: boolean } = {}) =>
    act(async () =>
      root.render(
        <InstalledPluginModule
          host={host}
          module={module}
          active={options.active ?? true}
          theme={{ mode: "light", tokens: {} }}
          locale="zh"
          onDiagnostic={vi.fn()}
          taskPorts={options.ports === false ? null : task.ports}
          onOpenTask={open}
        />,
      ),
    );
  const projection = () =>
    JSON.parse(
      container.querySelector('[data-plugin-content-slot="main.content"]')
        ?.textContent ?? "null",
    ) as Record<string, unknown> | null;
  const mounted = () =>
    act(async () => {
      await vi.waitFor(() => expect(projection()?.pluginUiReady).toBe(true));
    });
  return {
    task,
    container,
    open,
    render,
    projection,
    mounted,
    gateMount() {
      gate = deferred<Response>();
      return gate;
    },
    lease,
  };
}
it("restores explicit creation for a mounted legacy projection consumer and opens its original GET-confirmed task", async () => {
  const f = fixture();
  await f.render();
  await f.mounted();
  expect(
    f.task.requests.filter((request) => request.method === "POST"),
  ).toHaveLength(0);
  const navigation = f.container.querySelector(
    'section[aria-label="模块任务"]',
  )!;
  expect(navigation.textContent).toBe("创建任务");
  await act(async () => navigation.querySelector("button")!.click());
  await act(async () => {
    await vi.waitFor(() =>
      expect(f.projection()).toMatchObject({
        threadId: "prepared-thread",
        expectedThreadRevision: 23,
      }),
    );
  });
  expect(
    f.task.requests.filter((request) => request.method === "POST"),
  ).toHaveLength(1);
  expect(navigation.textContent).toBe("打开任务");
  await act(async () => navigation.querySelector("button")!.click());
  expect(f.open).toHaveBeenCalledWith("prepared-thread");
  expect(f.container.textContent).not.toContain("任务与连接");
  expect(f.container.querySelector("details, summary, select")).toBeNull();
});
it("retries a legacy creation with its original key after an unconfirmed HTTP result", async () => {
  const f = fixture();
  let responseLost = true;
  f.task.setHandler((request) => {
    if (request.method === "POST" && responseLost)
      throw new Error("named-legacy-creation-response-lost");
    return undefined;
  });
  await f.render();
  await f.mounted();
  const navigation = f.container.querySelector(
    'section[aria-label="模块任务"]',
  )!;
  await act(async () => navigation.querySelector("button")!.click());
  await act(async () => {
    await vi.waitFor(() =>
      expect(navigation.querySelector("button")!.textContent).toBe(
        "重试创建任务",
      ),
    );
  });
  expect(f.open).not.toHaveBeenCalled();
  responseLost = false;
  await act(async () => navigation.querySelector("button")!.click());
  await act(async () => {
    await vi.waitFor(() =>
      expect(f.projection()).toMatchObject({
        threadId: "prepared-thread",
        expectedThreadRevision: 23,
      }),
    );
  });
  const posts = f.task.requests.filter((request) => request.method === "POST");
  expect(posts).toHaveLength(2);
  expect(posts[0]!.key).toBeTruthy();
  expect(posts[1]!.key).toBe(posts[0]!.key);
  expect(posts[1]!.body).toEqual(posts[0]!.body);
  expect(navigation.textContent).toBe("打开任务");
});
it("recovers an already created legacy thread through GET retry without preparing another thread", async () => {
  const f = fixture();
  let threadReads = 0;
  let readUnavailable = true;
  f.task.setHandler((request) => {
    if (
      request.method === "GET" &&
      request.path === "/api/v1/threads/prepared-thread"
    ) {
      threadReads++;
      if (readUnavailable && threadReads > 1)
        throw new Error("named-legacy-known-thread-read-unavailable");
    }
    return undefined;
  });
  await f.render();
  await f.mounted();
  const navigation = f.container.querySelector(
    'section[aria-label="模块任务"]',
  )!;
  await act(async () => navigation.querySelector("button")!.click());
  await act(async () => {
    await vi.waitFor(() =>
      expect(navigation.querySelector("button")!.textContent).toBe(
        "重试读取任务",
      ),
    );
  });
  expect(navigation.querySelector("button")!.disabled).toBe(false);
  expect(f.open).not.toHaveBeenCalled();
  const posts = () =>
    f.task.requests.filter((request) => request.method === "POST");
  expect(posts()).toHaveLength(1);
  readUnavailable = false;
  await act(async () => navigation.querySelector("button")!.click());
  await act(async () => {
    await vi.waitFor(() =>
      expect(f.projection()).toMatchObject({
        taskContextReady: true,
        threadId: "prepared-thread",
        expectedThreadRevision: 23,
      }),
    );
  });
  expect(posts()).toHaveLength(1);
  expect(threadReads).toBeGreaterThan(2);
  expect(navigation.textContent).toBe("打开任务");
  await act(async () => navigation.querySelector("button")!.click());
  expect(f.open).toHaveBeenCalledWith("prepared-thread");
});
it.each([
  "crewon.project-conversations",
  "crewon.project-conversation-association",
  "crewon.project-generation-contexts",
])("keeps %s project modules as content-only surfaces", async (service) => {
  const f = fixture(service);
  await f.render();
  await f.mounted();
  expect(
    f.container.querySelector("section, button, details, summary"),
  ).toBeNull();
  expect(
    f.task.requests.filter((request) => request.method === "POST"),
  ).toHaveLength(0);
  const shell = f.container.cloneNode(true) as HTMLElement;
  shell.querySelector(
    '[data-plugin-content-slot="main.content"]',
  )!.textContent = "Plugin-owned project content";
  expect(shell.innerHTML).toMatchSnapshot();
});
it("does not supply legacy fallback controls for a different project conversation protocol version", async () => {
  const f = fixture("crewon.project-conversations", "2");
  await f.render();
  await f.mounted();
  expect(
    f.container.querySelector('section[aria-label="模块任务"]'),
  ).toBeNull();
  expect(
    f.task.requests.filter((request) => request.method === "POST"),
  ).toHaveLength(0);
});
it("cannot prepare before the mount is validated or without original task ports", async () => {
  const f = fixture();
  const gate = f.gateMount();
  await f.render();
  expect(
    f.container.querySelector('section[aria-label="模块任务"]'),
  ).toBeNull();
  expect(f.task.requests).toHaveLength(0);
  await act(async () => gate.resolve(controlUiResponse(f.lease)));
  await f.mounted();
  await f.render({ ports: false });
  expect(
    f.container.querySelector('section[aria-label="模块任务"]'),
  ).toBeNull();
  expect(f.task.requests).toHaveLength(0);
});
it("keeps inactive modules free of task controls and preparation", async () => {
  const f = fixture();
  await f.render({ active: false });
  expect(f.container.textContent).toBe("");
  expect(f.task.requests).toHaveLength(0);
});
