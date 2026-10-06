import assert from "node:assert/strict";
import test from "node:test";
import {
  captureProjectMediaInputAuthorization,
  projectMediaInputAuthority,
  type ProjectMediaInputAuthorizationPort,
} from "./project-media-input-application-authority.ts";
const actor = {
  tenantId: "tenant",
  spaceId: "space",
  principalId: "principal",
  actorId: "actor",
};
function authority(authorization: ProjectMediaInputAuthorizationPort) {
  return projectMediaInputAuthority({
    actor,
    projectId: "project",
    action: "read",
    review: null,
    mediaInputId: null,
    inputRevision: null,
    command: null,
    authorization,
  });
}
test("older PDP still authorizes every before/transaction check when no transaction hook exists", async () => {
  let calls = 0;
  const a = authority(
    captureProjectMediaInputAuthorization({
      authorize: async () => {
        calls++;
        return { outcome: "allow" };
      },
      assertActive: () => {},
    }),
  );
  await a.assertCurrent();
  await a.assertTransactionCurrent();
  assert.equal(calls, 2);
});
test("captured transaction PDP checks are independent, awaited and preserve denial after callback replacement", async () => {
  const state = { current: 0, transaction: 0, allow: false };
  const port: ProjectMediaInputAuthorizationPort = {
    authorize: async () => {
      state.current++;
      return { outcome: "allow" };
    },
    authorizeTransaction: async () => {
      await Promise.resolve();
      state.transaction++;
      return state.allow
        ? { outcome: "allow" }
        : { outcome: "deny", reasonCode: "withdrawn" };
    },
    assertActive: () => {},
  };
  const a = authority(captureProjectMediaInputAuthorization(port));
  port.authorizeTransaction = async () => ({ outcome: "allow" });
  await a.assertCurrent();
  await assert.rejects(() => a.assertTransactionCurrent(), {
    code: "project_media_input_denied",
  });
  state.allow = true;
  await a.assertTransactionCurrent();
  assert.deepEqual(state, { current: 1, transaction: 2, allow: true });
});
test("transaction PDP accessors or non-functions cannot acquire authority", () => {
  let getters = 0;
  const port = {
    authorize: async () => ({ outcome: "allow" as const }),
    assertActive: () => {},
  };
  assert.throws(() =>
    captureProjectMediaInputAuthorization(
      Object.defineProperty({ ...port }, "authorizeTransaction", {
        enumerable: true,
        get() {
          getters++;
          return port.authorize;
        },
      }),
    ),
  );
  assert.equal(getters, 0);
  assert.throws(() =>
    captureProjectMediaInputAuthorization({
      ...port,
      authorizeTransaction: null,
    } as unknown as ProjectMediaInputAuthorizationPort),
  );
});
