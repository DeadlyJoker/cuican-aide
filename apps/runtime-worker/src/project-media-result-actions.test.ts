import assert from "node:assert/strict";
import test from "node:test";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
import { mediaResultFixture } from "./project-media-result-publisher.test-support.ts";
const signal = () => ({ signal: new AbortController().signal });
for (const backend of ["sqlite", "postgres"] as const) {
  for (const kind of ["T10", "D18"] as const) {
    test(
      `${backend} ${kind}: output discovery reads original observed positions without fetching, saving, generating or adopting`,
      assetTestOptions(backend),
      async (t) => {
        const f = await mediaResultFixture(t, backend, kind);
        const query = { projectId: f.query.projectId, runId: f.query.runId };
        const before = f.materialCounts(),
          source = await f.referenceSource();
        const initial = await f.publisher.listOutputs(f.actor, query, signal());
        assert.equal(initial.reference.projectId, query.projectId);
        assert.deepEqual(initial.outputs, [
          { resultIndex: 0, candidate: null },
          { resultIndex: 1, candidate: null },
        ]);
        assert.equal(f.state.gets, 0);
        assert.equal(f.state.dns, 0);
        assert.equal(await f.count(), 0);
        const saved = await f.publisher.publish(
          f.actor,
          { ...query, resultIndex: 1 },
          signal(),
        );
        const result = await f.publisher.listOutputs(f.actor, query, signal());
        assert.deepEqual(result.outputs, [
          { resultIndex: 0, candidate: null },
          { resultIndex: 1, candidate: saved.candidate },
        ]);
        assert.equal(f.state.gets, 1);
        assert.deepEqual(f.materialCounts(), before);
        assert.deepEqual(await f.referenceSource(), source);
        f.state.onGrant = async (p) => {
          if (p.resource.resultIndex === 1) f.state.read = false;
        };
        await assert.rejects(f.publisher.listOutputs(f.actor, query, signal()));
        assert.equal(f.state.gets, 1);
      },
    );
  }
  test(
    `${backend}: an unobserved original operation never becomes invented output positions`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaResultFixture(t, backend, "T10", { observe: false });
      await assert.rejects(
        f.publisher.listOutputs(
          f.actor,
          { projectId: f.query.projectId, runId: f.query.runId },
          signal(),
        ),
        /project_media_result_not_ready/,
      );
      assert.equal(f.state.gets, 0);
      assert.equal(await f.count(), 0);
    },
  );
  test(
    `${backend}: result SQL verifies the current UI installation in addition to the original generation provenance`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaResultFixture(t, backend);
      const saved = await f.publisher.publish(f.actor, f.query, signal());
      const uiInstallation = {
        installation: f.target.installation,
        selection: f.target.selection,
        package: f.target.package,
      };
      const grant = { ...f.authority("publish"), uiInstallation };
      const replay = await f.store.saveCandidate(saved.candidate, grant);
      assert.equal(replay.disposition, "replayed");
      const altered = {
        ...uiInstallation,
        installation: {
          ...f.target.installation,
          selectionRevision: f.pin.selectionRevision + 1,
        },
        selection: {
          ...f.target.selection,
          revision: f.pin.selectionRevision + 1,
        },
      };
      await assert.rejects(
        f.store.saveCandidate(saved.candidate, {
          ...grant,
          uiInstallation: altered,
        }),
      );
      await assert.rejects(
        f.store.loadSource(f.request, {
          ...f.authority(),
          uiInstallation: altered,
        }),
      );
      assert.equal(await f.count(), 1);
      assert.equal(f.state.gets, 1);
    },
  );
}
