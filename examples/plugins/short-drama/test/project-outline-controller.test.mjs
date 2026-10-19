import assert from "node:assert/strict";
import test from "node:test";
import { ProjectOutlineController } from "../src/workbench/ProjectOutlineController.ts";
import {
  createPluginProjectOutlineUiClient,
  parseProjectOutlineUiRequest,
  parseProjectOutlineUiResponse,
} from "../src/project-outlines-service.ts";
import { outlineReadFixture } from "./project-outline-read.test-support.mjs";
import { deferred } from "./persistent-ui.test-support.mjs";
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("reads adopted output in exact bounded pages, opens a candidate history, and never writes", async () => {
  const service = outlineReadFixture(),
    c = new ProjectOutlineController(
      createPluginProjectOutlineUiClient(service.services),
    );
  try {
    c.setProject("outline-project");
    c.setReady(true);
    await tick();
    assert.equal(c.getSnapshot().revision.contentRevision, 1);
    assert.equal(c.getSnapshot().sections.get("episodes").length, 10);
    await c.loadSection("episodes", true);
    assert.equal(c.getSnapshot().sections.get("episodes").length, 12);
    assert.equal(c.getSnapshot().next.get("episodes"), null);
    await c.loadHistory();
    await c.openRevision(c.getSnapshot().history[1]);
    assert.equal(c.getSnapshot().revision.contentRevision, 2);
    assert.equal(c.getSnapshot().view.artifact.selectedContentRevision, 1);
    assert.ok(
      service.calls.every((call) =>
        /\.(?:getOutline|getSection|listRevisions)$/u.test(call.action),
      ),
    );
    assert.ok(
      service.calls
        .filter((call) => call.action.endsWith("getSection"))
        .every((call) => call.input.limit === 10),
    );
  } finally {
    c.dispose();
  }
});
test("late old-project reads are ignored and reconnect automatically rereads the current project", async () => {
  const late = deferred(),
    old = outlineReadFixture(),
    current = outlineReadFixture("new-project");
  const client = createPluginProjectOutlineUiClient({
    async invoke(action, input, options) {
      if (
        input.projectId === "outline-project" &&
        action.endsWith("getOutline")
      )
        return late.promise;
      return current.services.invoke(action, input, options);
    },
  });
  const c = new ProjectOutlineController(client);
  try {
    c.setProject("outline-project");
    c.setReady(true);
    await tick();
    c.setProject("new-project");
    await c.refresh();
    late.resolve({ view: old.view });
    await tick();
    assert.equal(c.getSnapshot().view.artifact.projectId, "new-project");
    const reads = current.calls.length;
    c.setReady(false);
    c.setReady(true);
    await tick();
    assert.ok(current.calls.length > reads);
    assert.equal(c.getSnapshot().revision.projectId, "new-project");
  } finally {
    c.dispose();
  }
});
test("old Host falls back but transport failure stays visible and retryable", async () => {
  for (const [message, state] of [
    ["plugin_ui_actions_unavailable", "unsupported"],
    ["connection_closed", "error"],
  ]) {
    const c = new ProjectOutlineController(
      createPluginProjectOutlineUiClient({
        async invoke() {
          throw Error(message);
        },
      }),
    );
    try {
      c.setProject("outline-project");
      c.setReady(true);
      await tick();
      assert.equal(c.getSnapshot().state, state);
    } finally {
      c.dispose();
    }
  }
});
test("codec rejects getters, excessive payload, foreign scope and a non-progressing continuation", async () => {
  let accessed = false;
  assert.throws(() =>
    parseProjectOutlineUiRequest({
      action: "crewon.project-outlines.v2.getOutline",
      input: {
        get projectId() {
          accessed = true;
          return "outline-project";
        },
      },
    }),
  );
  assert.equal(accessed, false);
  assert.throws(() =>
    parseProjectOutlineUiRequest({
      action: "crewon.project-outlines.v2.saveCandidate",
      input: { projectId: "outline-project" },
    }),
  );
  const f = outlineReadFixture(),
    request = {
      action: "crewon.project-outlines.v2.getSection",
      input: {
        projectId: "outline-project",
        artifactId: "outline-artifact",
        contentRevision: 1,
        contentDigest: f.revisions[0].contentDigest,
        section: "episodes",
        afterIndex: 0,
        limit: 10,
      },
    };
  const page = await f.services.invoke(request.action, request.input);
  assert.throws(() =>
    parseProjectOutlineUiResponse(request, {
      ...page,
      revision: { ...page.revision, projectId: "foreign" },
    }),
  );
  assert.throws(() =>
    parseProjectOutlineUiResponse(request, { ...page, nextIndex: 0 }),
  );
  assert.throws(() =>
    parseProjectOutlineUiResponse(request, {
      ...page,
      items: [{ summary: "大".repeat(22000) }],
    }),
  );
  assert.deepEqual(parseProjectOutlineUiResponse(request, page), page);
});

test("background outline hint preserves explicit history and does not enter loading", async () => {
  const service = outlineReadFixture(),
    c = new ProjectOutlineController(
      createPluginProjectOutlineUiClient(service.services),
    );
  try {
    c.setProject("outline-project");
    c.setReady(true);
    await tick();
    await c.loadHistory();
    await c.openRevision(c.getSnapshot().history[1]);
    const states = [];
    c.subscribe(() => states.push(c.getSnapshot().state));
    c.invalidate("outline-project");
    await tick();
    await tick();
    assert.equal(c.getSnapshot().revision.contentRevision, 2);
    assert.equal(c.getSnapshot().view.artifact.selectedContentRevision, 1);
    assert.ok(!states.includes("loading"));
  } finally {
    c.dispose();
  }
});

test("outline hints coalesce behind physical writes and reject another project", async () => {
  const service = outlineReadFixture();
  let pending = false;
  const c = new ProjectOutlineController(
    createPluginProjectOutlineUiClient(service.services),
    { physicalWritesPending: () => pending },
  );
  try {
    c.setProject("outline-project");
    c.setReady(true);
    await tick();
    pending = true;
    const before = service.calls.length;
    c.invalidate("other");
    c.invalidate("outline-project");
    c.invalidate("outline-project");
    await tick();
    assert.equal(service.calls.length, before);
    pending = false;
    c.refreshWriteActivity();
    await tick();
    await tick();
    assert.equal(
      service.calls.slice(before).filter((x) => x.action.endsWith("getOutline"))
        .length,
      1,
    );
  } finally {
    c.dispose();
  }
});
