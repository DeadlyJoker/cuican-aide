import assert from "node:assert/strict";
import test from "node:test";
import { InstalledPluginUnmeteredAuthority } from "./installed-plugin-unmetered-authority.ts";
import { InstalledPluginTaskHttpAuthority } from "./installed-plugin-credit-quote-authority.ts";
import {
  actor,
  scope,
  endpoint,
} from "./installed-plugin-task.test-support.ts";

const pin = {
  ...actor,
  profileId: scope.profileId,
  pluginId: "example.drama",
  publisherId: "example",
  version: "1.0.0",
  packageDigest: "sha256:" + "a".repeat(64),
  selectionRevision: 1,
  contributionId: "workbench",
  action: "project.execute",
  authorityEpoch: "policy-1",
};
test("explicit unmetered authority preserves the exact pin and rechecks policy before commit, without a quote", async () => {
  let revision = 1,
    allowed = true,
    calls = 0;
  const controller = new AbortController();
  const http = new InstalledPluginTaskHttpAuthority({
    timeoutMs: 1000,
    fetch: async (_url, options) => {
      calls++;
      assert.deepEqual(JSON.parse(options!.body as string), {
        schemaVersion: "crewon.plugin-task-unmetered-policy.v1",
        actor,
        pin,
      });
      return Response.json({
        outcome: allowed ? "allow" : "deny",
        authorization: allowed
          ? { authorityId: "approved-acceptance", policyRevision: revision }
          : null,
      });
    },
  });
  const authority = new InstalledPluginUnmeteredAuthority({
    endpoint,
    http,
    currentSignal: () => controller.signal,
    assertCurrent: async () => {},
  });
  const prepared = await authority.prepareGeneration({ actor, pin });
  await prepared.assertCurrent();
  revision++;
  await assert.rejects(prepared.assertCurrent(), /unmetered_policy_denied/);
  allowed = false;
  await assert.rejects(
    authority.prepareGeneration({ actor, pin }),
    /unmetered_policy_denied/,
  );
  const before = calls;
  await assert.rejects(
    authority.prepareGeneration({
      actor: { ...actor, tenantId: "foreign" },
      pin,
    }),
  );
  assert.equal(calls, before);
  controller.abort();
  assert.throws(prepared.assertActive);
  await http.close();
});
