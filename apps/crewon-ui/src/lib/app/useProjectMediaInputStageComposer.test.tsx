// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { useProjectMediaInputStageComposer } from "./useProjectMediaInputStageComposer";
import {
  api,
  binding,
  selection,
  scriptView,
  deferred,
} from "../control-runtime/controlProjectMediaInputStage.test-support";
type Input = Parameters<typeof useProjectMediaInputStageComposer>[0];
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
  let latest!: ReturnType<typeof useProjectMediaInputStageComposer>;
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
    latest = useProjectMediaInputStageComposer(input);
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
    work: (value: ReturnType<typeof useProjectMediaInputStageComposer>) => void,
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
const catalog = {
  configuration: {
    revision: 1,
    workflows: [
      "krea2-reference-four-view",
      "flux2-three-reference-storyboard",
    ],
  },
};
function reads(
  tail: (url: string) => Response | Promise<Response> = () =>
    Response.json(scriptView()),
) {
  return api(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("project-media-input-stage"))
      return Response.json({ available: true });
    if (path.endsWith("media-input-options")) return Response.json(catalog);
    return tail(path);
  });
}
it("real availability and reviewed options choose configuration; D18 requires an adopted script", async () => {
  const f = await fixture(reads());
  expect(f.current().selection).toEqual(selection);
  expect(f.current().blocked).toBe(false);
  await f.change((s) => s.setWorkflowId("flux2-three-reference-storyboard"));
  expect(f.current().blocked).toBe(true);
  await f.change((s) => s.setEpisodeId("episode-1"));
  expect(f.current().blocked).toBe(false);
  expect(f.current().selection?.stage).toEqual({
    ...selection.stage,
    workflowId: "flux2-three-reference-storyboard",
    script: {
      artifactId: "script-episode-1",
      episodeId: "episode-1",
      contentRevision: 1,
    },
  });
  await f.change((s) => s.setEpisodeId("missing"));
  expect(f.current().blocked).toBe(true);
  expect(f.current().selection?.stage.script).toBeNull();
});
it("only reviewed workflows appear, and absent or unsupported deployment leaves ordinary chat usable", async () => {
  const f = await fixture(
    api(async (url) =>
      Response.json(
        String(url).endsWith("media-input-options")
          ? {
              configuration: {
                revision: 4,
                workflows: ["flux2-three-reference-storyboard"],
              },
            }
          : { available: true },
      ),
    ),
  );
  expect(f.current().workflowId).toBe("flux2-three-reference-storyboard");
  expect(f.current().workflows).toEqual(["flux2-three-reference-storyboard"]);
  expect(f.current().selection?.stage.configurationRevision).toBe(4);
  expect(f.current().blocked).toBe(true);
  for (const response of [
    { available: false },
    { configuration: null },
    {
      error: {
        category: "notFound",
        code: "route_not_found",
        requestId: "fixture",
      },
    },
  ]) {
    const fetch = vi.fn(
      async (
        url: Parameters<typeof globalThis.fetch>[0],
        _init?: RequestInit,
      ) =>
        Response.json(
          String(url).endsWith("project-media-input-stage") &&
            !("available" in response) &&
            !("error" in response)
            ? { available: true }
            : response,
          { status: "error" in response ? 404 : 200 },
        ),
    );
    const absent = await fixture(api(fetch), { active: false });
    expect(absent.current().available).toBe(false);
    expect(absent.current().blocked).toBe(false);
    expect(absent.current().selection).toBeNull();
    await absent.render({ active: true });
    expect(absent.current().blocked).toBe(true);
    expect(
      fetch.mock.calls.every(
        ([, init]) => init === undefined || init.method === "GET",
      ),
    ).toBe(true);
  }
});
it("late catalog or script responses cannot replace a new project or episode", async () => {
  const gate = deferred<Response>();
  let signal: AbortSignal | null | undefined;
  const f = await fixture(
    api(async (url, init) => {
      if (String(url).endsWith("project-media-input-stage"))
        return Response.json({ available: true });
      signal = init?.signal;
      return gate.promise;
    }),
  );
  await f.render({ client: null, binding: null });
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    gate.resolve(Response.json(catalog));
    await flush();
  });
  expect(f.current().selection).toBeNull();
  expect(f.current().available).toBe(false);
  const script = deferred<Response>();
  await f.render({
    client: reads((path) =>
      path.endsWith("episode-1")
        ? script.promise
        : Response.json(scriptView("episode-2")),
    ),
    binding,
  });
  await f.change((s) => s.setEpisodeId("episode-1"));
  await f.change((s) => s.setEpisodeId("episode-2"));
  await act(async () => {
    script.resolve(Response.json(scriptView()));
    await flush();
  });
  expect(f.current().selection?.stage.script?.episodeId).toBe("episode-2");
});
it("stale or unselected scripts block preparation and catalog refresh never overwrites retained original sources", async () => {
  const stale = {
    view: {
      ...scriptView().view,
      dependencyState: "stale",
      staleReasons: ["brief-changed"],
    },
  };
  const f = await fixture(reads(() => Response.json(stale)));
  await f.change((s) => s.setEpisodeId("episode-1"));
  expect(f.current().blocked).toBe(true);
  const original = {
    ...selection,
    stage: {
      ...selection.stage,
      configurationRevision: 1,
      script: {
        artifactId: "old-script",
        episodeId: "removed",
        contentRevision: 2,
      },
    },
  };
  await f.render({ retained: original, briefRevision: 2, refresh: 1 });
  expect(f.current().selection).toEqual(original);
  expect(f.current().blocked).toBe(false);
  await f.render({
    binding: {
      ...binding,
      source: { ...binding.source, selectionRevision: 3 },
    },
  });
  expect(f.current().selection).toBeNull();
  expect(f.current().blocked).toBe(true);
});
