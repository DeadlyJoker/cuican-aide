import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type {
  CommitExtensionTurnInput,
  ProjectConversationCommitAuthority,
} from "@crewon/application";
import { createProjectConversationBinding } from "@crewon/domain";
import type { publicationFixture } from "./project-generation-publication.test-support.ts";
import { extensionStoreDigester as digester } from "./extension-store-records.ts";
import { timestamp } from "./extension-store.test-support.ts";

export async function bindConceptThread(
  f: Pick<
    Awaited<ReturnType<typeof publicationFixture>>,
    "first" | "actor" | "installs" | "sourcePin"
  > & {
    reference: Readonly<{ projectId: string }>;
  },
  input: CommitExtensionTurnInput,
  projectId = f.reference.projectId,
) {
  const {
    tenantId,
    spaceId,
    profileId,
    pluginId,
    publisherId,
    version,
    packageDigest,
    selectionRevision,
  } = f.sourcePin;
  const installation = {
    tenantId,
    spaceId,
    profileId,
    pluginId,
    publisherId,
    version,
    packageDigest,
    selectionRevision,
  };
  const scope = { tenantId, spaceId, profileId };
  const pkg = await f.installs.loadPackage({ scope, packageDigest });
  const selection = await f.installs.loadSelection({ scope, pluginId });
  const thread = await f.first.parent.loadThread({
    tenantId,
    threadId: input.binding.threadId!,
  });
  assert.ok(pkg && selection && thread);
  const store = f.first.parent.projectConversationStore();
  await store.migrate();
  const authority: ProjectConversationCommitAuthority = {
    version: "crewon.project-conversation-commit.v1",
    actor: f.actor,
    installation,
    selection,
    package: pkg,
    pin: { ...f.sourcePin, action: "project.execute" },
    assertActive() {},
    async assertCurrent() {},
    async assertTransactionCurrent() {},
  };
  const binding = createProjectConversationBinding(
    {
      bindingId: randomUUID(),
      owner: f.actor,
      profileId,
      projectId,
      threadId: thread.threadId,
      workspaceId: thread.workspaceId ?? null,
      revision: 1,
      state: "active",
      currentInstallation: installation,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    digester,
  );
  await store.commitBinding(
    {
      kind: "create",
      binding,
      expectedRevision: 0,
      existingThread: { expectedRevision: thread.revision },
      receipt: {
        actor: f.actor,
        idempotencyKey: "bind-concept-thread",
        requestDigest: digester.sha256(binding.bindingId),
      },
    },
    { authority },
  );
  const revoke = async () => {
    const { schemaVersion: _schema, contentDigest: _digest, ...body } = binding;
    await store.commitBinding(
      {
        kind: "set-state",
        expectedRevision: 1,
        binding: createProjectConversationBinding(
          { ...body, revision: 2, state: "revoked" },
          digester,
        ),
        receipt: {
          actor: f.actor,
          idempotencyKey: "revoke-concept-thread",
          requestDigest: digester.sha256("revoke-concept-thread"),
        },
      },
      { authority },
    );
  };
  return { binding, store, revoke };
}
