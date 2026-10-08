import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import type { PluginTaskAdmission } from "@crewon/domain";
import { nativeActor } from "../installed-plugin-native-authority.test-support.ts";
import { nativeFoundationFixture } from "./native-project-foundation-runtime.test-support.ts";

test("old v3 metadata/conversation opt-in does not infer Foundation Node authorization", async (t) => {
  const f = await nativeFoundationFixture(t, false);
  assert.equal(f.config, undefined);
  assert.ok(f.worker.installedPluginExecution.projectTools);
  assert.equal(f.worker.installedPluginExecution.projectMedia, undefined);
});

test("Main independent Node opt-in reaches actual Native Worker and borrows the original project store", async (t) => {
  const f = await nativeFoundationFixture(t);
  assert.ok(f.config);
  const created = await f.createProject();
  const service = f.config.createFoundations({ store: f.f.store });
  const query = { projectId: created.project.projectId };
  assert.deepEqual(
    await service.getFoundation(nativeActor, query),
    created.foundation,
  );
  const installedBefore = await f.f.store
    .pluginInstallationStore()
    .loadSelection({ scope: f.f.scope, pluginId: f.f.identity.pluginId });
  await assert.rejects(
    service.getFoundation({ ...nativeActor, actorId: "foreign" }, query),
  );
  const denied = await f.config.authorization.authorize({
    actor: nativeActor,
    action: "creativeProject:create",
    resource: {
      kind: "creativeProject",
      tenantId: nativeActor.tenantId,
      spaceId: nativeActor.spaceId,
      projectId: null,
    },
  });
  assert.equal(denied.outcome, "deny");
  await f.worker.close();
  await assert.rejects(service.getFoundation(nativeActor, query));
  const reopened = f.open().installedPluginExecution.projectFoundationTools;
  assert.ok(reopened);
  assert.deepEqual(
    await reopened
      .createFoundations({ store: f.f.store })
      .getFoundation(nativeActor, query),
    created.foundation,
  );
  assert.deepEqual(
    await f.f.store
      .pluginInstallationStore()
      .loadSelection({ scope: f.f.scope, pluginId: f.f.identity.pluginId }),
    installedBefore,
  );
  assert.equal(f.worker.installedPluginExecution.projectMedia, undefined);
});

test("Native Foundation service grant binds actual owner/profile/publication/package and cancellation", async (t) => {
  const f = await nativeFoundationFixture(t);
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
    await assert.rejects(async () =>
      f.config!.authorizeService({ ...admission, [key]: "foreign" }, signal),
    );
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(async () =>
    f.config!.authorizeService(admission, cancelled.signal),
  );
});

test("Main approval withdrawal revokes Foundation service grants and already-created metadata service", async (t) => {
  const f = await nativeFoundationFixture(t);
  assert.ok(f.config);
  const created = await f.createProject();
  const service = f.config.createFoundations({ store: f.f.store });
  writeFileSync(
    f.f.approvalPath,
    Buffer.concat([readFileSync(f.f.approvalPath), Buffer.from(" ")]),
  );
  await assert.rejects(
    service.getFoundation(nativeActor, {
      projectId: created.project.projectId,
    }),
  );
  await assert.rejects(async () =>
    f.config!.authorizeService(
      {
        ...nativeActor,
        ...f.f.scope,
        ...f.f.identity,
        contributionId: "workbench",
        action: "project.execute",
      } as PluginTaskAdmission,
      new AbortController().signal,
    ),
  );
});
