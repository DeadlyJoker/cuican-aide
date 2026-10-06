import assert from "node:assert/strict";
import test from "node:test";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
import { mediaInputUiFixture } from "./project-media-input-plugin-ui.test-support.ts";
import {
  parseListMediaInputsResponse,
  parseMediaInputOptionsResponse,
} from "@crewon/contracts/project-media-input-catalog";
import type { SaveMediaInputResponse } from "@crewon/contracts/project-media-inputs";

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: live UI catalog discovers original revisions in bounded pages, including cold SQL reopen`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaInputUiFixture(t, backend);
      const q = {
        projectId: f.query.projectId,
        afterMediaInputId: null,
        limit: 1,
      };
      assert.deepEqual(
        await f.invoke("crewon.project-media-inputs.v1.listInputs", q),
        { inputs: [], nextMediaInputId: null },
      );
      const a = (await f.saveUi()) as SaveMediaInputResponse;
      const b = (await f.saveUi({
        ...f.command(),
        idempotencyKey: "second-confirmed-input",
      })) as SaveMediaInputResponse;
      const c = (await f.saveUi(f.command("D18"))) as SaveMediaInputResponse;
      await f.saveUi({
        ...f.command(),
        mediaInputId: a.input.mediaInputId,
        expectedInputRevision: 1,
        idempotencyKey: "edit-catalog-input",
        prompt: "Keep the original identity.",
      });
      const ids = [
        a.input.mediaInputId,
        b.input.mediaInputId,
        c.input.mediaInputId,
      ].sort();
      let cursor: string | null = null;
      for (const [index, mediaInputId] of ids.entries()) {
        const request = { ...q, afterMediaInputId: cursor };
        const page = parseListMediaInputsResponse(
          request,
          await f.invoke("crewon.project-media-inputs.v1.listInputs", request),
        );
        assert.equal(page.inputs.length, 1);
        assert.equal(page.inputs[0]!.mediaInputId, mediaInputId);
        assert.equal(
          page.inputs[0]!.latestInputRevision,
          mediaInputId === a.input.mediaInputId ? 2 : 1,
        );
        assert.equal(Object.hasOwn(page.inputs[0]!, "prompt"), false);
        assert.equal(page.nextMediaInputId, index === 2 ? null : mediaInputId);
        cursor = page.nextMediaInputId;
      }
      const counts = await f.countMedia();
      assert.deepEqual(
        parseMediaInputOptionsResponse(
          await f.invoke("crewon.project-media-inputs.v1.getOptions", {
            projectId: q.projectId,
          }),
        ),
        {
          configuration: {
            revision: f.target.configuration.revision,
            workflows: [
              "krea2-reference-four-view",
              "flux2-three-reference-storyboard",
            ],
          },
        },
      );
      const cold = await f.cold();
      const page = await cold.app.listInputs(f.actor, { ...q, limit: 16 });
      assert.deepEqual(
        page.inputs.map((input) => input.mediaInputId),
        ids,
      );
      assert.deepEqual(await f.countMedia(), counts);
      await f.noExecution();
    },
  );
  test(
    `${backend}: catalog rejects denied read, foreign owner and expired invocation without execution`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaInputUiFixture(t, backend);
      const query = {
        projectId: f.query.projectId,
        afterMediaInputId: null,
        limit: 8,
      };
      f.controlState.revoked = true;
      await assert.rejects(
        f.invoke("crewon.project-media-inputs.v1.listInputs", query),
      );
      f.controlState.revoked = false;
      await assert.rejects(
        f.invoke("crewon.project-media-inputs.v1.listInputs", {
          ...query,
          projectId: "foreign-project",
        }),
      );
      f.stateUi.allowed = false;
      await assert.rejects(
        f.invoke("crewon.project-media-inputs.v1.getOptions", {
          projectId: query.projectId,
        }),
      );
      await f.noExecution();
    },
  );
}
