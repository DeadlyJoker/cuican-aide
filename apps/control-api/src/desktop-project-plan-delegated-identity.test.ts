import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, realpath, chmod, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadDesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import { DesktopPluginAuthority } from "./desktop-plugin-authority.ts";
import { createDesktopProjectPlanDelegatedIdentity } from "./desktop-project-plan-delegated-identity.ts";
import {
  actor,
  scope,
  digester,
} from "./installed-plugin-task.test-support.ts";
/** Genuine private-file loader/authority; package identities are schema fixtures and no package is installed/executed. */
async function fixture(t: TestContext, approved = true) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "crewon-plan-delegated-identity-")),
  );
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const pin = {
    pluginId: "example.short-drama",
    packageDigest: digester.sha256("named-plan-package"),
    contributionId: "workbench",
  };
  const projects = {
    version: "crewon.desktop-project-execution.v1",
    pluginUi: { publications: [pin] },
    textArtifacts: { version: "crewon.project-text.v1" },
    textUi: { publications: [pin] },
    conversations: { publications: [pin] },
    ...(approved ? { textPlans: { publications: [pin] } } : {}),
  };
  const document = {
    schemaVersion: "crewon.desktop-plugin-bootstrap.v3",
    actor,
    scope,
    authorityEpoch: "named-current-native-epoch-0000001",
    installRoot: join(root, "plugins"),
    sources: [
      {
        sourceId: "named-source",
        directory: join(root, "source"),
        pluginId: pin.pluginId,
        publisherId: "example",
        version: "17.0.0",
        packageDigest: pin.packageDigest,
      },
    ],
    publications: [
      {
        pluginId: pin.pluginId,
        publisherId: "example",
        packageDigest: pin.packageDigest,
        publicAssets: ["ui.mjs"],
      },
    ],
    projects,
  };
  const path = join(root, "bootstrap.json");
  await writeFile(path, JSON.stringify(document), { mode: 0o600 });
  const configuration = await loadDesktopPluginConfiguration(path, { actor }),
    authority = new DesktopPluginAuthority(configuration, [pin]);
  t.after(() => authority.close());
  const resolver = createDesktopProjectPlanDelegatedIdentity({
    configuration,
    authority,
    assertCurrent: () => authority.assertScope(actor, scope),
  });
  const input = {
    actor,
    scope,
    installation: {
      ...scope,
      ...pin,
      publisherId: "example",
      version: "17.0.0",
      selectionRevision: 2,
    },
    delegation: {
      kind: "pluginUi" as const,
      contributionId: "workbench",
      actionId: "crewon.project-text-plans.v1.start" as const,
      invocationId: "server-invocation",
      idempotencyKey: "original-key",
      inputDigest: digester.sha256("named-input"),
    },
  };
  const { contributionId: _contribution, ...installation } = input.installation;
  return {
    path,
    document,
    resolver,
    authority,
    input: { ...input, installation },
  };
}
test("actual private bootstrap independently approves plan identity and preserves full owner/profile/package", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(
    await f.resolver.resolveCurrentActor(f.input, new AbortController().signal),
    actor,
  );
  for (const patch of [
    { actor: { ...actor, principalId: "foreign" } },
    { scope: { ...scope, profileId: "foreign" } },
    {
      installation: {
        ...f.input.installation,
        packageDigest: digester.sha256("foreign"),
      },
    },
    { delegation: { ...f.input.delegation, contributionId: "foreign" } },
  ])
    await assert.rejects(
      f.resolver.resolveCurrentActor(
        { ...f.input, ...patch },
        new AbortController().signal,
      ),
    );
});
test("old conversations metadata approval does not imply a plan delegation identity", async (t) => {
  const f = await fixture(t, false);
  await assert.rejects(
    f.resolver.resolveCurrentActor(f.input, new AbortController().signal),
    /project_text_plan_authorization_unavailable/,
  );
});
test("actual private-file epoch drift and authority withdrawal reject the previously captured delegate", async (t) => {
  const f = await fixture(t);
  await f.resolver.resolveCurrentActor(f.input, new AbortController().signal);
  await writeFile(
    f.path,
    JSON.stringify({
      ...f.document,
      authorityEpoch: "changed-current-native-epoch-00001",
    }),
    { mode: 0o600 },
  );
  await assert.rejects(
    f.resolver.resolveCurrentActor(f.input, new AbortController().signal),
  );
  const other = await fixture(t);
  other.authority.withdraw();
  await assert.rejects(
    other.resolver.resolveCurrentActor(
      other.input,
      new AbortController().signal,
    ),
  );
});
