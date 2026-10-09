import assert from "node:assert/strict";
import test from "node:test";
import { captureProjectOutlineSourceReader } from "./project-outline-source-reader.ts";

test("an optional downstream source method cannot execute accessor-based configuration", () => {
  let called = false;
  const input = Object.create({
    get loadOutlineSourceRevision() {
      called = true;
      throw new Error("must not execute configuration getter");
    },
  });
  assert.throws(
    () => captureProjectOutlineSourceReader(input),
    /project_text_store_result_invalid/,
  );
  assert.equal(called, false);
  assert.deepEqual(captureProjectOutlineSourceReader({}), {});
});

test("the optional source reader retains the original receiver and method across later configuration mutation", async () => {
  const input = {
    reads: 0,
    async loadOutlineSourceRevision() {
      this.reads++;
      return null;
    },
  };
  const captured = captureProjectOutlineSourceReader(input);
  input.loadOutlineSourceRevision = async () => {
    throw new Error("later replacement must not execute");
  };
  assert.equal(
    await captured.loadOutlineSourceRevision!({
      owner: { tenantId: "tenant", spaceId: "space", principalId: "principal" },
      projectId: "project",
      artifactId: "outline",
      contentRevision: 1,
    }),
    null,
  );
  assert.equal(input.reads, 1);
});
