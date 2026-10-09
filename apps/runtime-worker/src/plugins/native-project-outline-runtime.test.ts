import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import type { PluginTaskAdmission } from "@crewon/domain";
import { nativeActor } from "../installed-plugin-native-authority.test-support.ts";
import { nativeOutlineFixture } from "./native-project-outline-runtime.test-support.ts";

test("old Main publication does not implicitly enable structured outline writes", async (t) => {
  const f = await nativeOutlineFixture(t, false);
  assert.equal(f.config, undefined);
  assert.ok(f.worker.installedPluginExecution.projectTools);
  assert.equal(
    f.worker.installedPluginExecution.projectFoundationTools,
    undefined,
  );
});
test("actual Main outline declaration reaches the existing Native parent store and survives reopen", async (t) => {
  const f = await nativeOutlineFixture(t);
  assert.ok(f.config);
  const created = await f.createProject(),
    query = { projectId: created.project.projectId };
  const service = f.config.createOutlines({ store: f.f.store });
  assert.equal(await service.getOutline(nativeActor, query), null);
  await assert.rejects(
    service.getOutline({ ...nativeActor, actorId: "foreign" }, query),
  );
  const selection = await f.f.store
    .pluginInstallationStore()
    .loadSelection({ scope: f.f.scope, pluginId: f.f.identity.pluginId });
  await f.worker.close();
  await assert.rejects(service.getOutline(nativeActor, query));
  const reopened = f.open().installedPluginExecution.projectOutlineTools;
  assert.ok(reopened);
  assert.equal(
    await reopened
      .createOutlines({ store: f.f.store })
      .getOutline(nativeActor, query),
    null,
  );
  assert.deepEqual(
    await f.f.store
      .pluginInstallationStore()
      .loadSelection({ scope: f.f.scope, pluginId: f.f.identity.pluginId }),
    selection,
  );
});
test("Native outline grant matches actual owner, profile, package and module; cancellation and withdrawal revoke it", async (t) => {
  const f = await nativeOutlineFixture(t);
  assert.ok(f.config);
  const admission = {
    ...nativeActor,
    ...f.f.scope,
    ...f.f.identity,
    contributionId: "workbench",
    action: "project.execute",
  } as PluginTaskAdmission;
  const signal = new AbortController().signal;
  await f.config.authorizeService(admission, signal);
  for (const key of [
    "principalId",
    "actorId",
    "tenantId",
    "spaceId",
    "profileId",
    "pluginId",
    "publisherId",
    "version",
    "packageDigest",
    "contributionId",
    "action",
  ] as const)
    await assert.rejects(
      f.config.authorizeService({ ...admission, [key]: "foreign" }, signal),
    );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(async () =>
    f.config!.authorizeService(admission, abort.signal),
  );
  writeFileSync(
    f.f.approvalPath,
    Buffer.concat([readFileSync(f.f.approvalPath), Buffer.from(" ")]),
  );
  await assert.rejects(async () =>
    f.config!.authorizeService(admission, signal),
  );
});
test("approved inactive outline updates neither execute nor break the old active runtime", async (t) => {
  const f = await nativeOutlineFixture(t, true, {
    inactiveOutlinePublication: "replace",
  });
  assert.equal(f.config, undefined);
  assert.ok(f.worker.installedPluginExecution.projectTools);
  const mixed = await nativeOutlineFixture(t, true, {
    inactiveOutlinePublication: "append",
  });
  assert.ok(mixed.config);
  await assert.rejects(
    mixed.config.authorizeService(
      {
        ...nativeActor,
        ...mixed.f.scope,
        ...mixed.f.identity,
        contributionId: "workbench",
        action: "project.execute",
        version: "99.0.0",
      } as PluginTaskAdmission,
      new AbortController().signal,
    ),
  );
});
