import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createProjectConversationBinding,
  parsePluginTaskAdmissionPin,
} from "@crewon/domain";
import type { mediaGenerationFixture } from "./project-media-generation.test-support.ts";

/** Attach the existing idle fixture Thread through the original binding writer. No Run, lease or Tool result is fabricated. */
export async function bindMediaGenerationFixtureThread(
  f: Awaited<ReturnType<typeof mediaGenerationFixture>>,
) {
  const conversations = f.parent.projectConversationStore();
  await conversations.migrate();
  const installation = f.target.installation;
  const scope = {
    tenantId: f.actor.tenantId,
    spaceId: f.actor.spaceId,
    profileId: installation.profileId,
  };
  const ledger = f.parent.pluginInstallationStore();
  const selection = await ledger.loadSelection({
    scope,
    pluginId: installation.pluginId,
  });
  const pkg = await ledger.loadPackage({
    scope,
    packageDigest: installation.packageDigest,
  });
  assert.ok(selection);
  assert.ok(pkg);
  const binding = createProjectConversationBinding(
    {
      bindingId: randomUUID(),
      owner: f.actor,
      profileId: scope.profileId,
      projectId: f.command.projectId,
      threadId: "media-task-thread",
      workspaceId: null,
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
      existingThread: { expectedRevision: 1 },
      receipt: {
        actor: f.actor,
        idempotencyKey: "worker-media-project-binding",
        requestDigest: f.digester.sha256("worker-media-project-binding"),
      },
    },
    {
      authority: {
        version: "crewon.project-conversation-commit.v1",
        actor: f.actor,
        installation,
        selection,
        package: pkg,
        pin: parsePluginTaskAdmissionPin({
          ...f.pin,
          action: "project.execute",
        }),
        assertCurrent: async () => {},
        assertTransactionCurrent: async () => {},
        assertActive: () => {},
      },
    },
  );
  return binding;
}
