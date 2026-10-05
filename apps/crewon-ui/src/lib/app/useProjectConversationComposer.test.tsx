// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { ControlApiClient } from "@crewon/control-client";
import type { ProjectConversationComposerSelection } from "../control-runtime/controlProjectConversationTurn";
import { useProjectConversationComposer } from "./useProjectConversationComposer";
const at = "2026-10-06T00:00:00.000Z",
  projectId = "project/中文 %2F";
const digest = `sha256:${"a".repeat(64)}`;
const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});
const publicTextView = {
  artifact: {
    projectId,
    artifactId: "outline",
    kind: "outline",
    episodeId: null,
    revision: 2,
    latestContentRevision: 1,
    selectedContentRevision: 1,
    locked: false,
    createdAt: at,
    updatedAt: at,
  },
  selectedRevision: {
    projectId,
    artifactId: "outline",
    kind: "outline",
    episodeId: null,
    contentRevision: 1,
    brief: { briefRevision: 1, contentDigest: digest },
    outline: null,
    content: {
      title: "雨夜来信",
      logline: "旧信归来",
      synopsis: "修复师遇见旧人。",
      episodes: [
        { episodeId: "episode/中文", title: "第一集", summary: "雨夜来信。" },
      ],
    },
    contentDigest: digest,
    createdAt: at,
  },
  dependencyState: "current",
  staleReasons: [],
};
const binding = {
  bindingId: "binding",
  projectId,
  threadId: "actual-project-thread",
  workspaceId: "workspace-original",
  revision: 1,
  state: "active",
  source: {
    pluginId: "crewon.short-drama",
    publisherId: "example.publisher",
    version: "16.0.0",
    packageDigest: `sha256:${"a".repeat(64)}`,
    selectionRevision: 2,
  },
  createdAt: at,
  updatedAt: at,
};
const project = {
  projectId,
  kind: "short-drama",
  title: "项目",
  revision: 2,
  state: "active",
  latestBriefRevision: 1,
  createdAt: at,
  updatedAt: at,
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((r) => {
      resolve = r;
    }),
    resolve,
  };
}
async function fixture(fetch: typeof globalThis.fetch) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const client = new ControlApiClient({
    baseUrl: "https://control.test",
    accessToken: "user-token",
    csrfToken: "csrf",
    fetch,
  });
  let latest!: ReturnType<typeof useProjectConversationComposer>;
  function View({
    threadId,
    revision,
    retainedSelection,
  }: {
    threadId: string;
    revision: number;
    retainedSelection?: ProjectConversationComposerSelection | null;
  }) {
    latest = useProjectConversationComposer({
      client,
      threadId,
      threadRevision: revision,
      locale: "zh",
      busy: false,
      retainedSelection,
    });
    return latest.view;
  }
  const render = async (
    threadId = "actual-project-thread",
    revision = 1,
    retainedSelection?: ProjectConversationComposerSelection | null,
  ) => {
    await act(async () => {
      root.render(
        <View
          threadId={threadId}
          revision={revision}
          retainedSelection={retainedSelection}
        />,
      );
      await new Promise((r) => setTimeout(r, 0));
    });
  };
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await render();
  return { container, render, current: () => latest };
}
it("initial binding read blocks send, shows the real project stages and retains phase on same Thread update", async () => {
  const gate = deferred<Response>();
  let bindingReads = 0;
  const f = await fixture(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("project-conversation")) {
      if (++bindingReads === 1) return gate.promise;
      return Response.json({ binding });
    }
    return Response.json(
      path.endsWith("outline") ? { view: publicTextView } : { project },
    );
  });
  expect(f.current().blocked).toBe(true);
  expect(f.current().selection).toBe(null);
  await act(async () => {
    gate.resolve(Response.json({ binding }));
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(f.current().blocked).toBe(false);
  expect(f.current().selection?.binding.workspaceId).toBe("workspace-original");
  const select = f.container.querySelector("select")!;
  await act(async () => {
    select.value = "outline";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(f.current().selection?.stage).toEqual({
    kind: "outline",
    briefRevision: 1,
  });
  await f.render("actual-project-thread", 2);
  expect(f.current().selection?.stage).toEqual({
    kind: "outline",
    briefRevision: 1,
  });
  expect(f.container.textContent).toMatchSnapshot();
});
it("unbound/old-server chats keep original UI; a late old Thread response cannot replace new owner", async () => {
  const old = deferred<Response>();
  const f = await fixture(async (url) =>
    new URL(String(url)).pathname.includes("actual-project-thread")
      ? old.promise
      : Response.json({ binding: null }),
  );
  await f.render("ordinary-thread", 1);
  expect(f.current().blocked).toBe(false);
  expect(f.container.childNodes).toHaveLength(0);
  await act(async () => {
    old.resolve(Response.json({ binding }));
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(f.current().selection).toBe(null);
});
it("revoked binding and transient get failure stay blocked instead of defaulting to ordinary chat", async () => {
  const f = await fixture(async () =>
    Response.json({ binding: { ...binding, state: "revoked" } }),
  );
  expect(f.current().blocked).toBe(true);
  expect(f.container.textContent).toContain("暂不可用");
});
it("explicit readonly refresh observes manual project source changes without changing the selected phase or Thread", async () => {
  let edited = false;
  const calls: string[] = [];
  const f = await fixture(async (url) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    if (path.endsWith("project-conversation"))
      return Response.json({ binding });
    if (path.endsWith("outline"))
      return Response.json({
        view: edited
          ? {
              ...publicTextView,
              selectedRevision: {
                ...publicTextView.selectedRevision,
                brief: { briefRevision: 2, contentDigest: digest },
              },
            }
          : null,
      });
    return Response.json({
      project: {
        ...project,
        revision: edited ? 3 : 2,
        latestBriefRevision: edited ? 2 : 1,
      },
    });
  });
  const select = f.container.querySelector("select")!;
  expect(
    select.querySelector('option[value="script"]')?.hasAttribute("disabled"),
  ).toBe(true);
  await act(async () => {
    select.value = "outline";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  edited = true;
  await act(async () => {
    f.container.querySelector("button")!.click();
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(f.current().selection?.stage).toEqual({
    kind: "outline",
    briefRevision: 2,
  });
  expect(f.current().selection?.binding.threadId).toBe("actual-project-thread");
  expect(
    f.container
      .querySelector('option[value="script"]')
      ?.hasAttribute("disabled"),
  ).toBe(false);
  expect(
    calls.filter((path) => path.endsWith("project-conversation")),
  ).toHaveLength(2);
  expect(calls.every((path) => !path.endsWith("stages"))).toBe(true);
});

it("unknown original script retains its episode and source through actual readonly refresh; latest source waits for adoption", async () => {
  let edited = false;
  const f = await fixture(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("project-conversation"))
      return Response.json({
        binding: { ...binding, revision: edited ? 2 : 1 },
      });
    if (path.endsWith("outline"))
      return Response.json({ view: edited ? null : publicTextView });
    return Response.json({
      project: {
        ...project,
        revision: edited ? 3 : 2,
        latestBriefRevision: edited ? 2 : 1,
      },
    });
  });
  const original: ProjectConversationComposerSelection = {
    binding: { ...binding, state: "active" },
    stage: {
      kind: "script",
      episodeId: "episode/中文",
      briefRevision: 1,
      outline: { artifactId: "outline", contentRevision: 1 },
    },
  };
  await f.render("actual-project-thread", 2, original);
  edited = true;
  await act(async () => {
    f.container.querySelector("button")!.click();
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(f.current().selection).toEqual(original);
  expect(f.current().blocked).toBe(false);
  const selects = f.container.querySelectorAll("select");
  expect(selects[0]!.value).toBe("script");
  expect(selects[1]!.value).toBe("episode/中文");
  expect([...selects].every((select) => select.disabled)).toBe(true);
  expect(f.container.textContent).toContain("重试将继续原请求的阶段与来源");
  await f.render("actual-project-thread", 2, null);
  expect(f.current().selection?.stage).toEqual({ kind: "discussion" });
  expect(f.current().selection?.binding.revision).toBe(2);
});
