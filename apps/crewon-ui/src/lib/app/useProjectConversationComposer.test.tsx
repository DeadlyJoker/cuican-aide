// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { ControlApiClient } from "@crewon/control-client";
import type { ProjectConversationComposerSelection } from "../control-runtime/controlProjectConversationTurn";
import { useProjectConversationComposer } from "./useProjectConversationComposer";
import { notifyProjectConversationBindingChanged } from "../plugins/projectConversationBindingChanges";
import { ControlProjectMediaInputStageTurn } from "../control-runtime/controlProjectMediaInputStageTurn";
import { scriptView } from "../control-runtime/controlProjectMediaInputStage.test-support";
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
async function fixture(
  fetch: typeof globalThis.fetch,
  outlineProtocol: "legacy" | "v2" = "legacy",
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const client = new ControlApiClient({
    baseUrl: "https://control.test",
    accessToken: "user-token",
    csrfToken: "csrf",
    fetch: (url, options) =>
      outlineProtocol === "legacy" &&
      new URL(String(url)).pathname.startsWith("/api/v2/")
        ? Promise.resolve(
            Response.json(
              {
                error: {
                  category: "notFound",
                  code: "route_not_found",
                  message: "Older Control fixture",
                  requestId: "older-control",
                },
              },
              { status: 404 },
            ),
          )
        : fetch(url, options),
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
  return { client, container, render, current: () => latest };
}
it("mixed outline history reads every adopted episode page without promoting the latest structured candidate", async () => {
  const episodes = Array.from({ length: 23 }, (_, i) => ({
    episodeId: "episode-" + i,
    title: "第" + (i + 1) + "集",
  }));
  const selected = {
    projectId,
    artifactId: "outline",
    contentRevision: 1,
    contentDigest: digest,
    brief: { briefRevision: 1, contentDigest: digest },
    format: "legacy-v1",
    title: "已采用",
    createdAt: at,
    counts: { episodes: 23, characters: 0, scenes: 0, props: 0, beats: 0 },
    quality: null,
  };
  const view = {
    artifact: { ...publicTextView.artifact, latestContentRevision: 6 },
    selectedRevision: selected,
    latestRevision: {
      ...selected,
      contentRevision: 6,
      format: "structured-v2",
      title: "尚未采用",
      quality: { passed: true, problemCount: 0, failedGateCount: 0 },
    },
    staleReasons: [],
  };
  const pages: number[] = [];
  let legacyReads = 0;
  const f = await fixture(async (url) => {
    const u = new URL(String(url)),
      path = u.pathname;
    if (path.endsWith("project-conversation"))
      return Response.json({ binding });
    if (path.includes("/api/v2/") && path.endsWith("outline"))
      return Response.json({ view });
    if (path.endsWith("sections")) {
      const start = Number(u.searchParams.get("afterIndex"));
      pages.push(start);
      expect(u.searchParams.get("contentRevision")).toBe("1");
      expect(u.searchParams.get("contentDigest")).toBe(digest);
      const end = Math.min(start + 10, episodes.length);
      return Response.json({
        revision: selected,
        section: "episodes",
        startIndex: start,
        totalItems: episodes.length,
        items: episodes.slice(start, end),
        nextIndex: end < episodes.length ? end : null,
      });
    }
    if (path.endsWith("outline")) ++legacyReads;
    return Response.json({ project });
  }, "v2");
  expect(pages).toEqual([0, 10, 20]);
  expect(legacyReads).toBe(0);
  expect(f.current().blocked).toBe(false);
  const stage = f.container.querySelector("select")!;
  await act(async () => {
    stage.value = "script";
    stage.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const episodeSelect = f.container.querySelectorAll("select")[1]!;
  expect(Array.from(episodeSelect.options).map((o) => o.value)).toEqual(
    episodes.map((e) => e.episodeId),
  );
  expect(f.current().selection?.stage).toMatchObject({
    kind: "script",
    outline: { artifactId: "outline", contentRevision: 1 },
  });
});
it("a v2 authorization failure blocks the original project composer without silently falling back", async () => {
  let legacyReads = 0;
  const f = await fixture(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("project-conversation"))
      return Response.json({ binding });
    if (path.includes("/api/v2/"))
      return Response.json(
        { error: { code: "access_denied", message: "denied" } },
        { status: 403 },
      );
    if (path.endsWith("outline")) ++legacyReads;
    return Response.json({ project });
  }, "v2");
  expect(f.current().blocked).toBe(true);
  expect(legacyReads).toBe(0);
});
it("rereads an association made by the installed module on the same original Thread and ignores other client/Thread notifications", async () => {
  let attached = false,
    reads = 0;
  const gate = deferred<Response>();
  const f = await fixture(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("project-conversation")) {
      ++reads;
      return attached && path.includes(binding.threadId)
        ? gate.promise
        : Response.json({ binding: null });
    }
    return Response.json(
      path.endsWith("outline") ? { view: publicTextView } : { project },
    );
  });
  expect(f.current().selection).toBe(null);
  expect(f.current().blocked).toBe(false);
  const foreign = new ControlApiClient({
    baseUrl: "https://control.test",
    accessToken: "another-user",
    fetch: async () => {
      throw new Error("unexpected_request");
    },
  });
  await act(async () => {
    notifyProjectConversationBindingChanged(foreign, binding.threadId);
    notifyProjectConversationBindingChanged(f.client, "another-thread");
  });
  expect(reads).toBe(1);
  attached = true;
  await act(async () =>
    notifyProjectConversationBindingChanged(f.client, binding.threadId),
  );
  expect(reads).toBe(2);
  expect(f.current().blocked).toBe(true);
  await act(async () => {
    gate.resolve(Response.json({ binding }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(f.current().selection).toEqual({
    binding,
    stage: { kind: "discussion" },
  });
  expect(f.current().blocked).toBe(false);
  await f.render("ordinary-thread", 1);
  const before = reads;
  await act(async () =>
    notifyProjectConversationBindingChanged(f.client, binding.threadId),
  );
  expect(reads).toBe(before);
  expect(f.current().selection).toBe(null);
});
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
  expect(f.container.textContent).toContain("暂时无法读取项目会话");
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
it("original Composer selects reviewed media preparation, requires D18 script, and sends the exact selection through the original client", async () => {
  const posts: Array<{ path: string; body: unknown }> = [];
  const f = await fixture(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (init?.method === "POST") {
      posts.push({ path, body: JSON.parse(init.body as string) });
      return Response.json(
        {
          disposition: "committed",
          threadId: binding.threadId,
          threadRevision: 4,
          runId: "prepared-input-run",
          runRevision: 1,
          bindingRevision: 1,
          stageAdmissionDigest: digest,
        },
        { status: 201 },
      );
    }
    if (path.endsWith("project-conversation"))
      return Response.json({ binding });
    if (path.endsWith("project-asset-stage"))
      return Response.json({ available: false });
    if (path.endsWith("project-media-input-stage"))
      return Response.json({ available: true });
    if (path.endsWith("media-input-options"))
      return Response.json({
        configuration: {
          revision: 4,
          workflows: [
            "krea2-reference-four-view",
            "flux2-three-reference-storyboard",
          ],
        },
      });
    if (path.endsWith("outline"))
      return Response.json({ view: publicTextView });
    if (path.includes("/scripts/")) {
      const view = scriptView("episode/中文").view!;
      return Response.json({
        view: {
          ...view,
          artifact: { ...view.artifact, projectId },
          selectedRevision: { ...view.selectedRevision, projectId },
        },
      });
    }
    return Response.json({ project });
  });
  async function select(label: string, value: string) {
    await act(async () => {
      const el = f.container.querySelector(
        `select[aria-label="${label}"]`,
      ) as HTMLSelectElement;
      expect(el).not.toBeNull();
      el.value = value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  await select("创作阶段", "media-input");
  expect(f.current().selection).toBeNull();
  expect(f.current().assetSelection).toBeNull();
  expect(f.current().mediaInputSelection?.stage).toEqual({
    kind: "media-input",
    workflowId: "krea2-reference-four-view",
    configurationRevision: 4,
    briefRevision: 1,
    script: null,
  });
  await select("输入准备工作流", "flux2-three-reference-storyboard");
  expect(f.current().blocked).toBe(true);
  expect(posts).toHaveLength(0);
  await select("画面剧本来源", "episode/中文");
  expect(f.current().blocked).toBe(false);
  expect(f.container.innerHTML).toMatchSnapshot();
  const turns = new ControlProjectMediaInputStageTurn(
    f.client,
    () => "composer-input-key",
  );
  try {
    const receipt = await turns.start({
      threadId: binding.threadId,
      content: "准备雨夜相遇的画面，先不要生成。",
      expectedThreadRevision: 3,
      selection: f.current().mediaInputSelection!,
    });
    expect(receipt.runId).toBe("prepared-input-run");
    expect(posts).toEqual([
      {
        path: `/api/v1/threads/${binding.threadId}/project-media-input-stage`,
        body: {
          projectId,
          threadId: binding.threadId,
          content: "准备雨夜相遇的画面，先不要生成。",
          expectedThreadRevision: 3,
          expectedBindingRevision: 1,
          idempotencyKey: "composer-input-key",
          stage: f.current().mediaInputSelection!.stage,
        },
      },
    ]);
  } finally {
    await turns.close();
  }
});

it("a changed plugin source explains recovery and reloads the same Thread after its authorized association is updated", async () => {
  let refreshed = false;
  const f = await fixture(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("project-conversation"))
      return refreshed
        ? Response.json({ binding: { ...binding, revision: 2 } })
        : Response.json(
            {
              error: {
                category: "authorization",
                requestId: "source-changed-test",
                code: "project_conversation_authority_changed",
                message: "changed",
              },
            },
            { status: 403 },
          );
    return Response.json(
      path.endsWith("outline") ? { view: publicTextView } : { project },
    );
  });
  expect(f.current().blocked).toBe(true);
  expect(f.container.textContent).toContain("插件已更新");
  expect(f.container.textContent).not.toContain("重新进入会话");
  refreshed = true;
  await act(async () => {
    notifyProjectConversationBindingChanged(f.client, binding.threadId);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(f.current().blocked).toBe(false);
  expect(f.current().selection?.binding.threadId).toBe(binding.threadId);
  expect(f.current().selection?.binding.workspaceId).toBe(binding.workspaceId);
  expect(f.current().selection?.binding.revision).toBe(2);
  expect(f.container.querySelector('[role="alert"]')).toBeNull();
});
