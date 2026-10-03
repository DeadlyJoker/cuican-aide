import assert from "node:assert/strict";
import test from "node:test";
import { isPluginUiCommittedProjectGenerationAuthority } from "./plugin-ui-committed-task-authority.ts";
import { committedProjectGenerationFixture } from "./plugin-ui-committed-project-generation.test-support.ts";

test("only the actual configured receipt issuer advertises its captured exact generation mapping without persistent reads", () => {
  const f = committedProjectGenerationFixture();
  const before = [
    f.project.state.projectReads.length,
    f.project.state.linkReads,
    f.project.base.state.receiptReads,
  ];
  const supports = (authority: unknown, publication = f.publication) =>
    isPluginUiCommittedProjectGenerationAuthority({
      authority,
      publications: [publication],
    });
  assert.equal(supports(f.authority), true);
  assert.equal(
    supports(f.createAuthority({ projectGenerations: undefined })),
    false,
  );
  assert.equal(supports({ ...f.authority }), false);
  assert.equal(
    supports(Object.create(Object.getPrototypeOf(f.authority))),
    false,
  );
  assert.equal(supports(null), false);
  assert.equal(
    supports(f.authority, {
      ...f.publication,
      source: { ...f.publication.source, contributionId: "other.module" },
    }),
    false,
  );
  assert.equal(
    supports(f.authority, {
      ...f.publication,
      target: { ...f.publication.target, action: "other.generate" },
    }),
    false,
  );
  assert.equal(
    supports(f.authority, {
      ...f.publication,
      target: {
        ...f.publication.target,
        packageDigest: "sha256:" + "c".repeat(64),
      },
    }),
    false,
  );
  assert.deepEqual(
    [
      f.project.state.projectReads.length,
      f.project.state.linkReads,
      f.project.base.state.receiptReads,
    ],
    before,
  );
  assert.equal(f.project.base.state.commits.length, 0);
  assert.equal(f.project.base.state.quoteCalls, 0);
});
