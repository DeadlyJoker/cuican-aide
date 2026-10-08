import { repositoryFrozenPackageDirectory } from "./repository-frozen-package-directory.test-support.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, chmod, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import {
  ThreadApplicationService,
  type ProjectConversationCommitAuthority,
} from "@crewon/application";
import {
  createProjectConversationBinding,
  parsePluginTaskAdmissionPin,
} from "@crewon/domain";
import {
  installLocalPluginPackage,
  loadInstalledPluginBusinessRegistration,
} from "@crewon/plugin-host";
import {
  ProjectMediaGenerationCommands,
  type GenerateProjectMediaCommand,
} from "@crewon/media-runtime";
import { mediaGenerationFixture } from "../../runtime-worker/src/project-media-generation.test-support.ts";
import { InstalledPluginRequestOwner } from "./installed-plugin-request-owner.ts";
import { createInstalledPluginTaskRuntimeCore } from "./installed-plugin-task-runtime-core.ts";
import { InstalledProjectMediaGenerationAdmissions } from "./installed-project-media-generation-admissions.ts";
import { StandaloneIdentity } from "./standalone-adapters.ts";

/** Real installed bytes, parent database, project binding, Core and request owner; explicit fixture PDP/readiness/network. */
export async function mediaGenerationControlFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  kind: "T10" | "D18" = "T10",
) {
  const installRoot = await mkdtemp(join(tmpdir(), "crewon-media-control-"));
  const owned = await stat(installRoot);
  let close = async () => {};
  t.after(async () => {
    await close();
    const current = await stat(installRoot);
    assert.equal(current.dev, owned.dev);
    assert.equal(current.ino, owned.ino);
    await removeOwned(installRoot);
  });
  const pkg = await installLocalPluginPackage({
    directory: resolve(
      repositoryFrozenPackageDirectory(
        "output/extensions/installable-plugins/short-drama-media-worker-20261006/short-drama/21.0.1",
      ),
    ),
    installRoot,
    authorization: async () => ({ outcome: "allow" }),
  });
  const registration = await loadInstalledPluginBusinessRegistration({
    installRoot,
    expectedPluginId: pkg.descriptor.pluginId,
    expectedPublisherId: pkg.descriptor.publisherId,
    expectedVersion: pkg.descriptor.version,
    expectedPackageDigest: pkg.packageDigest,
    authorizeRead: async () => "allow",
    signal: new AbortController().signal,
  });
  const f = await mediaGenerationFixture(t, backend, {
    unmetered: true,
    installedFixture: {
      version: pkg.descriptor.version,
      publisherId: pkg.descriptor.publisherId,
      packageDigest: pkg.packageDigest,
      manifestDigest: registration.manifestDigest,
      implementationDigest: registration.implementationDigest,
      preset: "krea2-portrait",
      manifest: registration.manifest,
    },
  });
  const scope = {
    tenantId: f.actor.tenantId,
    spaceId: f.actor.spaceId,
    profileId: f.pin.profileId,
  };
  const state = {
    profileId: scope.profileId,
    epoch: "named-control-media",
    allowed: true,
    packageAllowed: true,
  };
  const token = "named-media-control-" + "s".repeat(32),
    csrf = "named-media-control-" + "c".repeat(32),
    origin = "http://127.0.0.1:18479";
  const identity = new StandaloneIdentity({
    actor: f.actor,
    sessionToken: token,
    csrfToken: csrf,
    allowedOrigins: [origin],
  });
  const profiles = {
    resolve: async () => ({ ...scope, profileId: state.profileId }),
  };
  const activation = await f.ext.loadExtensionActivation({
    ...f.actor,
    pluginId: f.pin.pluginId,
  });
  assert.ok(activation);
  const requests = new InstalledPluginRequestOwner({
    identity: { resolveCurrentActor: (r) => identity.resolveActor(r) },
    profiles,
    peer: {
      prepare: async () => ({
        catalog: {
          list: () => [f.registration],
          resolve: () => f.registration,
        },
        host: {
          taskAdmissionMode: () => "installed",
          validateConfiguration: async () => {},
          evaluate: async () => ({
            outcome: "ready",
            target: activation.target!,
          }),
        },
        pluginQueryHost: {
          resolveRegistration: async () => {
            throw new Error("named-query-disabled");
          },
          evaluate: async () => {
            throw new Error("named-query-disabled");
          },
        },
      }),
    },
  });
  const core = await createInstalledPluginTaskRuntimeCore({
    store: f.parent,
    requests,
    installRoot,
    maximumPackages: 4,
    publications: [
      { pluginId: f.pin.pluginId, packageDigest: f.pin.packageDigest },
    ],
    profiles,
    businessAuthorization: { authorize: async () => f.decision(state.allowed) },
    uiAuthorization: {
      authorize: async () =>
        state.allowed
          ? { outcome: "allow", authorityEpoch: state.epoch }
          : { outcome: "deny", reasonCode: "named-control-policy" },
    },
    authorizePackage: async (input) => {
      assert.deepEqual(Object.keys(input.candidate).sort(), [
        "descriptor",
        "packageDigest",
      ]);
      return state.packageAllowed ? "allow" : "deny";
    },
    unmeteredTasks: {
      prepareGeneration: async () => ({
        authorization: {
          authorityId: "named-control-unmetered",
          policyRevision: 1,
        },
        assertCurrent: async () => {},
        assertActive: () => {},
      }),
    },
    clock: f.dependencies.clock,
    ids: { nextId: () => randomUUID() },
    digester: f.digester,
    projectMediaGenerationStorage: {
      version: "crewon.project-media-generation-storage.v1",
    },
  });
  close = async () => {
    await core.close();
    await requests.close();
  };
  const admissions =
    await InstalledProjectMediaGenerationAdmissions.prepare(core);
  const conversations = f.parent.projectConversationStore();
  await conversations.migrate();
  const threads = new ThreadApplicationService({
    store: f.parent,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: f.dependencies.clock,
    ids: { nextId: () => randomUUID() },
    digester: f.digester,
    workspaceAdmission: { admit: async () => {} },
  });
  const thread = await threads.prepareCreateThread(f.actor, {
    kind: "thread.create",
    title: "Shared media project",
    workspaceId: "media-control-workspace",
    idempotencyKey: "media-control-thread",
  });
  const event = thread.events[0];
  assert.equal(event?.type, "thread.created");
  assert.ok(event);
  const installation = f.target.installation;
  const ledger = f.parent.pluginInstallationStore();
  const selected = await ledger.loadSelection({
    scope,
    pluginId: f.pin.pluginId,
  });
  const installed = await ledger.loadPackage({
    scope,
    packageDigest: f.pin.packageDigest,
  });
  assert.ok(selected);
  assert.ok(installed);
  const authority: ProjectConversationCommitAuthority = {
    version: "crewon.project-conversation-commit.v1",
    actor: f.actor,
    installation,
    selection: selected,
    package: installed,
    pin: parsePluginTaskAdmissionPin({ ...f.pin, action: "project.execute" }),
    assertCurrent: async () => {},
    assertTransactionCurrent: async () => {},
    assertActive: () => {},
  };
  const binding = createProjectConversationBinding(
    {
      bindingId: randomUUID(),
      owner: f.actor,
      profileId: scope.profileId,
      projectId: f.command.projectId,
      threadId: event.identity.threadId,
      workspaceId: "media-control-workspace",
      revision: 1,
      state: "active",
      currentInstallation: installation,
      createdAt: f.dependencies.clock.now(),
      updatedAt: f.dependencies.clock.now(),
    },
    f.digester,
  );
  await conversations.commitBinding(
    {
      kind: "create",
      binding,
      expectedRevision: 0,
      thread,
      receipt: {
        actor: f.actor,
        idempotencyKey: "media-control-binding",
        requestDigest: f.digester.sha256("media-control-binding"),
      },
    },
    { authority },
  );
  const saved = await f.app.saveInput(
    f.actor,
    kind === "T10" ? f.command : f.d18Command,
  );
  const command: GenerateProjectMediaCommand = {
    ...f.mediaQuery(saved.input),
    executionId: "media-control-execution",
    threadId: binding.threadId,
    expectedThreadRevision: 1,
    idempotencyKey: "media-control-command",
  };
  const commands = new ProjectMediaGenerationCommands({
    profileId: scope.profileId,
    preparer: f.issuer,
    tasks: core.extensionTasks,
    extensions: f.ext,
    admissions,
  });
  close = async () => {
    await commands.close();
    await core.close();
    await requests.close();
  };
  const request = {
    method: "POST",
    url: "/named-media-control-fixture",
    remoteAddress: "127.0.0.1",
    headers: {
      "authorization": `Bearer ${token}`,
      origin,
      "x-csrf-token": csrf,
    },
  };
  const run = <T>(work: () => Promise<T>) =>
    requests.run({ request, actor: f.actor }, work);
  const generate = (input = command) =>
    run(() =>
      commands.generate(f.actor, input, { signal: requests.currentSignal() }),
    );
  const revoke = async () => {
    const { schemaVersion: _, contentDigest: __, ...body } = binding;
    await conversations.commitBinding(
      {
        kind: "set-state",
        binding: createProjectConversationBinding(
          { ...body, revision: 2, state: "revoked" },
          f.digester,
        ),
        expectedRevision: 1,
        receipt: {
          actor: f.actor,
          idempotencyKey: "revoke-control-binding",
          requestDigest: f.digester.sha256("revoke-control-binding"),
        },
      },
      { authority },
    );
  };
  return {
    ...f,
    installRoot,
    core,
    requests,
    admissions,
    commands,
    command,
    binding,
    controlState: state,
    request,
    identity,
    generate,
    revoke,
    run,
  };
}
async function removeOwned(root: string) {
  await chmod(root, 0o700);
  for (const entry of await readdir(root, { withFileTypes: true }))
    if (entry.isDirectory()) await removeOwned(join(root, entry.name));
  await rm(root, { recursive: true });
}
