// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { useProjectAssetStageComposer } from "./useProjectAssetStageComposer";
import {
  api,
  binding,
  selection,
  scriptView,
  deferred,
} from "../control-runtime/controlProjectAssetStage.test-support";
type Input = Parameters<typeof useProjectAssetStageComposer>[0];
const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previous = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = previous;
});
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
async function fixture(client: Input["client"], initial: Partial<Input> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let latest!: ReturnType<typeof useProjectAssetStageComposer>;
  let current: Input = {
    client,
    binding,
    briefRevision: 1,
    episodeIds: ["episode-1", "episode-2"],
    active: true,
    threadRevision: 3,
    refresh: 0,
    retained: null,
    ...initial,
  };
  function View({ input }: { input: Input }) {
    latest = useProjectAssetStageComposer(input);
    return (
      <span>
        {latest.available ? "available" : "unavailable"}:
        {latest.blocked ? "blocked" : "ready"}
      </span>
    );
  }
  async function render(patch: Partial<Input> = {}) {
    current = { ...current, ...patch };
    await act(async () => {
      root.render(<View input={current} />);
      await flush();
    });
  }
  async function change(
    work: (value: ReturnType<typeof useProjectAssetStageComposer>) => void,
  ) {
    await act(async () => {
      work(latest);
      await flush();
    });
  }
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await render();
  return { render, change, current: () => latest, container };
}
it("only the independent true availability opt-in enables the stage; reads never submit or borrow conversations", async () => {
  const calls: Array<{ path: string; method: string }> = [];
  const client = api(async (url, init) => {
    calls.push({
      path: new URL(String(url)).pathname,
      method: init?.method ?? "GET",
    });
    return Response.json({ available: true });
  });
  const f = await fixture(client);
  expect(f.current().available).toBe(true);
  expect(f.current().blocked).toBe(false);
  expect(f.current().selection).toEqual(selection);
  expect(calls).toEqual([
    { path: "/api/v1/threads/thread/project-asset-stage", method: "GET" },
  ]);
  await f.change((value) => value.setAssetKind("prop"));
  expect(f.current().selection?.stage.assetKind).toBe("prop");
  expect(calls).toHaveLength(1);
  expect(f.container.textContent).toMatchInlineSnapshot('"available:ready"');
});
it("absent owner and old-server route keep ordinary composer inactive; selecting unavailable assets stays blocked", async () => {
  for (const response of [
    () => Response.json({ available: false }),
    () =>
      Response.json(
        {
          error: {
            category: "notFound",
            code: "route_not_found",
            message: "fixture",
            requestId: "fixture",
          },
        },
        { status: 404 },
      ),
  ]) {
    const fetch = vi.fn(async () => response()),
      f = await fixture(api(fetch), { active: false });
    expect(f.current().available).toBe(false);
    expect(f.current().selection).toBeNull();
    expect(f.current().blocked).toBe(false);
    await f.render({ active: true });
    expect(f.current().blocked).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  }
  const f = await fixture(null, { binding: null, active: false });
  expect(f.current().blocked).toBe(false);
  expect(f.current().selection).toBeNull();
});
it("script source uses the actual adopted script and rejects stale, unselected and foreign projections", async () => {
  const calls: string[] = [];
  let valid = true;
  const f = await fixture(
    api(async (url) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      if (path.endsWith("project-asset-stage"))
        return Response.json({ available: true });
      const response = scriptView();
      return Response.json(
        valid
          ? response
          : {
              view: {
                ...response.view,
                dependencyState: "stale",
                staleReasons: ["brief-changed"],
              },
            },
      );
    }),
  );
  await f.change((value) => value.setEpisodeId("episode-1"));
  expect(f.current().blocked).toBe(false);
  expect(f.current().selection?.stage.script).toEqual({
    artifactId: "script-episode-1",
    episodeId: "episode-1",
    contentRevision: 1,
  });
  expect(calls).toContain(
    "/api/v1/creative-projects/project%2F%E4%B8%AD%E6%96%87/text-artifacts/scripts/episode-1",
  );
  valid = false;
  await f.render({ refresh: 1 });
  expect(f.current().blocked).toBe(true);
  expect(f.current().selection?.stage.script).toBeNull();
  await f.change((value) => value.setEpisodeId("absent-episode"));
  expect(f.current().blocked).toBe(true);
  expect(calls.some((p) => p.includes("absent-episode"))).toBe(false);
});
it("missing selection, foreign project and changed brief cannot be presented as usable script sources", async () => {
  const original = scriptView();
  const responses = [
    {
      view: {
        ...original.view,
        artifact: { ...original.view!.artifact, selectedContentRevision: null },
        selectedRevision: null,
        dependencyState: "unselected",
        staleReasons: [],
      },
    },
    {
      view: {
        ...original.view,
        artifact: { ...original.view!.artifact, projectId: "foreign" },
        selectedRevision: {
          ...original.view!.selectedRevision,
          projectId: "foreign",
        },
      },
    },
    scriptView("episode-1", 2),
  ];
  for (const response of responses) {
    const f = await fixture(
      api(async (url) =>
        Response.json(
          new URL(String(url)).pathname.endsWith("project-asset-stage")
            ? { available: true }
            : response,
        ),
      ),
    );
    await f.change((value) => value.setEpisodeId("episode-1"));
    expect(f.current().blocked).toBe(true);
    expect(f.current().selection?.stage.script).toBeNull();
  }
});
it("late old script or project reads cannot replace the new selected episode or owner", async () => {
  const old = deferred<Response>();
  let oldSignal: AbortSignal | null | undefined;
  const client = api(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("project-asset-stage"))
      return Response.json({ available: true });
    if (path.endsWith("episode-1")) {
      oldSignal = init?.signal;
      return old.promise;
    }
    return Response.json(scriptView("episode-2"));
  });
  const f = await fixture(client);
  await f.change((value) => value.setEpisodeId("episode-1"));
  expect(f.current().blocked).toBe(true);
  await f.change((value) => value.setEpisodeId("episode-2"));
  expect(oldSignal?.aborted).toBe(true);
  expect(f.current().selection?.stage.script?.episodeId).toBe("episode-2");
  await act(async () => {
    old.resolve(Response.json(scriptView()));
    await flush();
  });
  expect(f.current().selection?.stage.script?.episodeId).toBe("episode-2");
  const oldAvailability = deferred<Response>();
  const another = api(async () => oldAvailability.promise);
  await f.render({
    client: another,
    binding: { ...binding, projectId: "other", bindingId: "other" },
  });
  expect(f.current().available).toBe(false);
  expect(f.current().blocked).toBe(true);
  await f.render({ client: null });
  await act(async () => {
    oldAvailability.resolve(Response.json({ available: true }));
    await flush();
  });
  expect(f.current().available).toBe(false);
  expect(f.current().selection).toBeNull();
  expect(f.current().blocked).toBe(true);
});
it("owner withdrawal and replacement abort the actual read; late availability cannot restore permission", async () => {
  const gate = deferred<Response>();
  let signal: AbortSignal | null | undefined;
  const f = await fixture(
    api(async (_u, init) => {
      signal = init?.signal;
      return gate.promise;
    }),
  );
  expect(f.current().blocked).toBe(true);
  await f.render({
    client: api(async () => Response.json({ available: false })),
  });
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    gate.resolve(Response.json({ available: true }));
    await flush();
  });
  expect(f.current().available).toBe(false);
  expect(f.current().blocked).toBe(true);
  await f.render({ binding: { ...binding, state: "revoked" } });
  expect(f.current().selection).toBeNull();
  expect(f.current().blocked).toBe(true);
});
it("unknown retained source remains original during readonly refresh, while a foreign full pin is rejected", async () => {
  const fetch = vi.fn(
    async (_url: Parameters<typeof globalThis.fetch>[0], _init?: RequestInit) =>
      Response.json({ available: true }),
  );
  const original = {
    ...selection,
    stage: {
      ...selection.stage,
      briefRevision: 1,
      script: {
        artifactId: "old-script",
        episodeId: "removed-episode",
        contentRevision: 2,
      },
    },
  };
  const f = await fixture(api(fetch), { briefRevision: 2, retained: original });
  expect(f.current().selection).toEqual(original);
  expect(f.current().blocked).toBe(false);
  await f.render({ binding: { ...binding, revision: 2 }, refresh: 1 });
  expect(f.current().selection).toEqual(original);
  expect(f.current().blocked).toBe(false);
  expect(fetch.mock.calls.every(([, init]) => init?.method === "GET")).toBe(
    true,
  );
  await f.render({
    binding: {
      ...binding,
      source: { ...binding.source, selectionRevision: 3 },
    },
  });
  expect(f.current().selection).toBeNull();
  expect(f.current().blocked).toBe(true);
});
it("refreshing saved episode choices removes unavailable sources without triggering repeated reads from new array identities", async () => {
  const fetch = vi.fn(async (url) =>
    Response.json(
      new URL(String(url)).pathname.endsWith("project-asset-stage")
        ? { available: true }
        : scriptView(),
    ),
  );
  const f = await fixture(api(fetch));
  await f.change((value) => value.setEpisodeId("episode-1"));
  expect(f.current().blocked).toBe(false);
  const before = fetch.mock.calls.length;
  await f.render({ episodeIds: ["episode-1", "episode-2"] });
  expect(fetch.mock.calls.length).toBe(before);
  await f.render({ episodeIds: ["episode-2"] });
  expect(f.current().blocked).toBe(true);
  expect(f.current().selection?.stage.script).toBeNull();
});
