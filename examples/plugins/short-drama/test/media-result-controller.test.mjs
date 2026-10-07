import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
const built = await build({
  entryPoints: [
    new URL("../src/workbench/ProjectMediaResultController.ts", import.meta.url)
      .pathname,
  ],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  target: "node24",
});
const { ProjectMediaResultController } = await import(
  `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString("base64")}`
);
function fixture() {
  const releases = [],
    calls = [];
  let listGate, previewGate;
  const candidate = {
    projectId: "project-a",
    candidateId: "candidate-a",
    runId: "original-run",
    resultIndex: 1,
    inputRevision: 2,
  };
  const controller = new ProjectMediaResultController({
    listCandidates: async (q) => {
      calls.push(q);
      await listGate;
      return { candidates: [candidate], nextCandidateId: null };
    },
    preview: async (q) => {
      calls.push(q);
      await previewGate;
      return { candidate, url: "blob:preview-a" };
    },
    releasePreview: async (url) => {
      releases.push(url);
    },
  });
  controller.setReady(true);
  controller.setProject("project-a");
  return {
    controller,
    candidate,
    calls,
    releases,
    gateList: (p) => {
      listGate = p;
    },
    gatePreview: (p) => {
      previewGate = p;
    },
  };
}
test("result preview uses the saved original position, and switch/close releases only owned media", async () => {
  const f = fixture();
  await f.controller.refresh();
  await f.controller.preview("candidate-a");
  assert.deepEqual(f.calls[1], {
    projectId: "project-a",
    runId: "original-run",
    resultIndex: 1,
  });
  assert.equal(f.controller.getSnapshot().preview.url, "blob:preview-a");
  f.controller.setProject("project-b");
  assert.equal(f.controller.getSnapshot().preview, null);
  assert.deepEqual(f.releases, ["blob:preview-a"]);
  f.controller.dispose();
});
test("a late page cannot populate another project, and a late preview is released", async () => {
  const f = fixture();
  let release;
  f.gateList(
    new Promise((r) => {
      release = r;
    }),
  );
  const pending = f.controller.refresh();
  f.controller.setProject("project-b");
  release();
  await pending;
  assert.equal(f.controller.getSnapshot().projectId, "project-b");
  assert.deepEqual(f.controller.getSnapshot().candidates, []);
  f.controller.setProject("project-a");
  f.gateList(null);
  await f.controller.refresh();
  f.gatePreview(
    new Promise((r) => {
      release = r;
    }),
  );
  const preview = f.controller.preview("candidate-a");
  f.controller.setReady(false);
  release();
  await preview;
  assert.equal(f.controller.getSnapshot().preview, null);
  assert.deepEqual(f.releases, ["blob:preview-a"]);
  f.controller.dispose();
});
test("read failures are retryable without issuing generation or adoption", async () => {
  let count = 0;
  const c = new ProjectMediaResultController({
    listCandidates: async () => {
      if (++count === 1) throw new Error("secret supplier URL");
      return { candidates: [], nextCandidateId: null };
    },
    preview: async () => {
      throw new Error("not called");
    },
    releasePreview: async () => {},
  });
  c.setReady(true);
  c.setProject("project");
  await c.refresh();
  assert.equal(c.getSnapshot().phase, "unavailable");
  assert.ok(!c.getSnapshot().error.includes("secret"));
  await c.refresh();
  assert.equal(c.getSnapshot().phase, "ready");
  c.dispose();
});
