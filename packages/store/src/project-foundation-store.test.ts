import assert from "node:assert/strict";
import test from "node:test";
import {
  setProjectFoundationCreativeStartMode,
  type ProjectSourcePage,
} from "@crewon/domain";
import {
  application,
  creationRecipe,
} from "./creative-project-store.test-support.ts";
import {
  actor,
  confirmationRecipe,
  digester,
  fixture,
  foundationCreationRecipe,
  foundationTables,
  mixedUnicodeSourceBundle,
  ordinaryAuthority,
  owner,
  parameterChangeRecipe,
  proposalRecipe,
  receipt,
  sourceBundle,
  sourceChangeRecipe,
  time,
  withDigest,
  type Backend,
} from "./project-foundation-store.test-support.ts";

const backends: readonly Backend[] = ["sqlite", "postgres"];
for (const backend of backends) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
    timeout: 30_000,
  };
  test(
    `${backend}: 20 MB canonical Unicode source persists complete chunks and bounded boundary pages`,
    { ...options, timeout: 60_000 },
    async (t) => {
      const f = await fixture(t, backend);
      const input = foundationCreationRecipe(
        "maximum-source",
        "create-maximum-source",
        "novel",
      );
      const bundle = mixedUnicodeSourceBundle(input.project, 20_000_000);
      const creation = {
        ...input,
        ...bundle,
        foundation: {
          ...input.foundation,
          source: { revision: 1, digest: bundle.source.digest },
        },
      };
      assert.equal(bundle.source.characterLength, 7_500_000);
      assert.equal(bundle.chunks.length, Math.ceil(20_000_000 / 4_096));
      assert.equal(
        bundle.chunks.reduce(
          (bytes, chunk) => bytes + Buffer.byteLength(chunk.content),
          0,
        ),
        20_000_000,
      );
      assert.ok(
        bundle.chunks.every(
          (chunk) => Buffer.byteLength(chunk.content) <= 4_096,
        ),
      );
      const result = await f.first.foundation.commitCreation(creation);
      assert.deepEqual(result.source, bundle.source);
      assert.equal(
        await f.count("project_source_chunks"),
        bundle.chunks.length,
      );
      assert.equal(await f.count("project_sources"), 1);
      await f.first.close();
      const reopened = await f.open();
      const scope = {
        owner: owner(),
        projectId: "maximum-source",
        revision: 1,
        digest: bundle.source.digest,
      };
      assert.deepEqual(
        await reopened.foundation.loadSource({
          owner: owner(),
          projectId: "maximum-source",
          revision: 1,
        }),
        bundle.source,
      );
      const boundary = await reopened.foundation.readSourcePage({
        ...scope,
        startOffset: 1_534,
        limit: 6,
      });
      assert.deepEqual(boundary, {
        sourceRevision: 1,
        startOffset: 1_534,
        endOffset: 1_540,
        content: "😀a雨😀a雨",
        nextOffset: 1_540,
      });
      const end = bundle.source.characterLength;
      const tail = await reopened.foundation.readSourcePage({
        ...scope,
        startOffset: end - 5,
        limit: 1_024,
      });
      assert.deepEqual(tail, {
        sourceRevision: 1,
        startOffset: end - 5,
        endOffset: end,
        content: "😀a雨😀a",
        nextOffset: null,
      });
      assert.deepEqual(
        await reopened.foundation.readSourcePage({
          ...scope,
          startOffset: end,
          limit: 1,
        }),
        {
          sourceRevision: 1,
          startOffset: end,
          endOffset: end,
          content: "",
          nextOffset: null,
        },
      );
      await assert.rejects(
        reopened.foundation.readSourcePage({
          ...scope,
          startOffset: end + 1,
          limit: 1,
        }),
      );
    },
  );

  test(
    `${backend}: 20 MB plus one canonical byte is rejected before any project/source/receipt writes`,
    { ...options, timeout: 60_000 },
    async (t) => {
      const f = await fixture(t, backend);
      const input = foundationCreationRecipe(
        "oversized-source",
        "create-oversized-source",
        "novel",
      );
      const bundle = mixedUnicodeSourceBundle(input.project, 20_000_001);
      const foundation = {
        ...input.foundation,
        source: { revision: 1, digest: bundle.source.digest },
      };
      const before = await f.counts();
      // Raw-file metadata cannot disguise a canonical body that exceeds its independent bound.
      await assert.rejects(
        f.first.foundation.commitCreation({
          ...input,
          ...bundle,
          source: { ...bundle.source, byteLength: 20_000_000 },
          foundation,
        }),
        /source_text_limit/,
      );
      // The raw-file manifest has its own exact size bound, even before canonical verification.
      await assert.rejects(
        f.first.foundation.commitCreation({ ...input, ...bundle, foundation }),
      );
      assert.deepEqual(await f.counts(), before);
      assert.equal(
        await f.first.projects.loadProject({
          owner: owner(),
          projectId: "oversized-source",
        }),
        null,
      );
      assert.equal(
        await f.first.foundation.loadMutationReceipt({
          actor,
          kind: "create-project",
          receipt: input.receipt,
        }),
        null,
      );
    },
  );
  test(
    `${backend}: explicit single and undecided series parameters survive persistence`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      for (const origin of ["creative", "novel"] as const) {
        for (const episodeMode of ["single", "series"] as const) {
          const projectId = `${origin}-${episodeMode}`;
          const input = foundationCreationRecipe(
            projectId,
            `create-${projectId}`,
            origin,
          );
          const foundation = {
            ...input.foundation,
            parameters: {
              ...input.foundation.parameters,
              episodeMode,
              episodeCount: episodeMode === "single" ? 1 : null,
            },
          };
          const result = await f.first.foundation.commitCreation({
            ...input,
            foundation,
          });
          assert.deepEqual(result.foundation.parameters, foundation.parameters);
          assert.equal(result.foundation.parameters.episodeMode, episodeMode);
        }
      }
      await f.first.close();
      const reopened = await f.open();
      for (const origin of ["creative", "novel"] as const) {
        for (const episodeMode of ["single", "series"] as const) {
          const foundation = await reopened.foundation.loadFoundation({
            owner: owner(),
            projectId: `${origin}-${episodeMode}`,
          });
          assert.equal(foundation!.parameters.episodeMode, episodeMode);
          assert.equal(
            foundation!.parameters.episodeCount,
            episodeMode === "single" ? 1 : null,
          );
        }
      }
    },
  );

  test(
    `${backend}: source chapters paginate by scalar offset and pin the exact owner/revision/digest`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const input = foundationCreationRecipe(
        "chapters",
        "create-chapters",
        "novel",
      );
      await f.first.foundation.commitCreation(input);
      const scope = {
        owner: owner(),
        projectId: "chapters",
        revision: 1,
        digest: input.source!.digest,
      };
      assert.deepEqual(
        await f.first.foundation.listSourceChapters({
          ...scope,
          afterStartOffset: null,
          limit: 1,
        }),
        { chapters: [input.chapters[0]], nextStartOffset: 0 },
      );
      assert.deepEqual(
        await f.first.foundation.listSourceChapters({
          ...scope,
          afterStartOffset: 0,
          limit: 1,
        }),
        { chapters: [input.chapters[1]], nextStartOffset: null },
      );
      assert.deepEqual(
        await f.first.foundation.listSourceChapters({
          ...scope,
          afterStartOffset: input.chapters[1]!.startOffset,
          limit: 1,
        }),
        { chapters: [], nextStartOffset: null },
      );
      for (const extra of [
        { digest: digester.sha256("other-manifest") },
        { revision: 2 },
        { owner: owner({ ...actor, principalId: "other-owner" }) },
        { limit: 51 },
        { limit: 0 },
        { afterStartOffset: -1 },
      ])
        await assert.rejects(
          f.first.foundation.listSourceChapters({
            ...scope,
            afterStartOffset: null,
            limit: 1,
            ...extra,
          }),
        );
      const empty = foundationCreationRecipe(
        "unindexed",
        "create-unindexed",
        "novel",
      );
      await f.first.foundation.commitCreation({ ...empty, chapters: [] });
      assert.deepEqual(
        await f.first.foundation.listSourceChapters({
          owner: owner(),
          projectId: "unindexed",
          revision: 1,
          digest: empty.source!.digest,
          afterStartOffset: null,
          limit: 50,
        }),
        { chapters: [], nextStartOffset: null },
      );
    },
  );

  test(
    `${backend}: reading an original project never attaches a foundation or migrates`,
    options,
    async (t) => {
      const f = await fixture(t, backend, { migrate: false });
      const legacy = creationRecipe("legacy", "legacy-create");
      await f.first.projects.commitProjectCreation(legacy);
      const tables = await f.tableNames();
      const scope = { owner: owner(), projectId: "legacy" };
      assert.equal(await f.first.foundation.loadFoundation(scope), null);
      assert.equal(
        await f.first.foundation.loadSource({ ...scope, revision: 1 }),
        null,
      );
      assert.equal(
        await f.first.foundation.loadProposal({ ...scope, revision: 1 }),
        null,
      );
      assert.deepEqual(
        await f.first.foundation.listProposals({
          ...scope,
          afterRevision: 0,
          limit: 1,
        }),
        { proposals: [], nextRevision: null },
      );
      assert.deepEqual(await f.tableNames(), tables);
      assert.deepEqual(
        await f.first.projects.loadProject(scope),
        legacy.project,
      );
      await f.first.foundation.migrate();
      assert.equal(await f.first.foundation.loadFoundation(scope), null);
      assert.equal(await f.count("project_foundations"), 0);
    },
  );

  test(
    `${backend}: creative and novel creation preserve v0 projects and atomically attach source records`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      for (const origin of ["creative", "novel"] as const) {
        const input = foundationCreationRecipe(
          origin,
          `create-${origin}`,
          origin,
        );
        const result = await f.first.foundation.commitCreation(input);
        const scope = { owner: owner(), projectId: origin };
        assert.equal(result.disposition, "committed");
        assert.deepEqual(result.project, input.project);
        assert.deepEqual(result.brief, input.initialBrief);
        assert.deepEqual(result.foundation, input.foundation);
        assert.deepEqual(
          await f.first.projects.loadProject(scope),
          input.project,
        );
        assert.deepEqual(
          await f.first.projects.loadBrief({ ...scope, briefRevision: 1 }),
          input.initialBrief,
        );
        assert.deepEqual(
          await f.first.foundation.loadFoundation(scope),
          input.foundation,
        );
        assert.equal(Object.hasOwn(result.project, "origin"), false);
        if (input.source !== null) {
          assert.deepEqual(
            await f.first.foundation.loadSource({ ...scope, revision: 1 }),
            input.source,
          );
          assert.notEqual(input.source.digest, input.source.fileDigest);
          let text = "",
            startOffset = 0;
          do {
            const page: ProjectSourcePage =
              await f.first.foundation.readSourcePage({
                ...scope,
                revision: 1,
                digest: input.source.digest,
                startOffset,
                limit: 3,
              });
            assert.equal(page.startOffset, startOffset);
            assert.equal(
              Array.from(page.content).length,
              page.endOffset - page.startOffset,
            );
            text += page.content;
            if (page.nextOffset === null) break;
            startOffset = page.nextOffset;
          } while (true);
          assert.equal(
            text,
            input.chunks.map((chunk) => chunk.content).join(""),
          );
          await assert.rejects(
            f.first.foundation.readSourcePage({
              ...scope,
              revision: 1,
              digest: digester.sha256("other"),
              startOffset: 0,
              limit: 3,
            }),
          );
          for (const limit of [0, 1_025])
            await assert.rejects(
              f.first.foundation.readSourcePage({
                ...scope,
                revision: 1,
                digest: input.source.digest,
                startOffset: 0,
                limit,
              }),
            );
        }
      }
      assert.equal(await f.count("creative_projects"), 2);
      assert.equal(await f.count("creative_project_mutation_receipts"), 0);
      assert.equal(await f.count("project_sources"), 1);
      assert.equal(await f.count("project_source_chunks"), 2);
      assert.equal(await f.count("project_source_chapters"), 2);
      assert.equal(await f.count("project_foundation_mutation_receipts"), 2);
    },
  );

  test(
    `${backend}: identity joins and source recipes fail closed across owner, tenant and project scopes`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const input = foundationCreationRecipe("owned", "create-owned", "novel");
      await f.first.foundation.commitCreation(input);
      const before = await f.counts();
      for (const stranger of [
        { ...actor, principalId: "other-principal" },
        { ...actor, tenantId: "other-tenant" },
        { ...actor, spaceId: "other-space" },
      ]) {
        const scope = { owner: owner(stranger), projectId: "owned" };
        assert.equal(await f.first.foundation.loadFoundation(scope), null);
        assert.equal(
          await f.first.foundation.loadSource({ ...scope, revision: 1 }),
          null,
        );
        assert.equal(
          await f.first.foundation.loadProposal({ ...scope, revision: 1 }),
          null,
        );
        await assert.rejects(
          f.first.foundation.commitCreation({
            ...input,
            actor: stranger,
            receipt: receipt(
              `stranger-${stranger.principalId}-${stranger.tenantId}-${stranger.spaceId}`,
            ),
          }),
        );
      }
      const cross = foundationCreationRecipe("cross", "create-cross", "novel");
      await assert.rejects(
        f.first.foundation.commitCreation({
          ...cross,
          source: { ...cross.source!, projectId: "owned" },
        }),
      );
      const changed = sourceChangeRecipe(
        input.project,
        input.foundation,
        "bad-source",
      );
      await assert.rejects(
        f.first.foundation.commitFoundationChange({
          ...changed,
          chunks: changed.chunks.map((chunk) => ({
            ...chunk,
            tenantId: "other-tenant",
          })),
        }),
      );
      assert.deepEqual(await f.counts(), before);
    },
  );

  test(
    `${backend}: actor-scoped receipt replay publishes the original immutable snapshot`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const input = foundationCreationRecipe("first", "stable-key", "novel");
      const first = await f.first.foundation.commitCreation(input);
      const fresh = foundationCreationRecipe(
        "unused-new-id",
        "stable-key",
        "novel",
      );
      assert.deepEqual(await f.first.foundation.commitCreation(fresh), {
        ...first,
        disposition: "replayed",
      });
      assert.equal(
        await f.first.projects.loadProject({
          owner: owner(),
          projectId: "unused-new-id",
        }),
        null,
      );
      assert.deepEqual(
        await f.first.foundation.loadMutationReceipt({
          actor,
          kind: "create-project",
          receipt: input.receipt,
        }),
        { ...first, disposition: "replayed" },
      );
      await assert.rejects(
        f.first.foundation.commitCreation({
          ...fresh,
          receipt: {
            ...input.receipt,
            requestDigest: digester.sha256("different-body"),
          },
        }),
      );
      assert.equal(await f.count("creative_projects"), 1);
      assert.equal(await f.count("project_foundation_mutation_receipts"), 1);
      const otherActor = { ...actor, actorId: "other-device" };
      assert.equal(
        await f.first.foundation.loadMutationReceipt({
          actor: otherActor,
          kind: "create-project",
          receipt: input.receipt,
        }),
        null,
      );
    },
  );

  test(
    `${backend}: saving immutable proposals does not advance the foundation and paginates bounded history`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const created = await f.first.foundation.commitCreation(
        foundationCreationRecipe("plans"),
      );
      const scope = { owner: owner(), projectId: "plans" };
      const first = proposalRecipe(
        created.project,
        created.foundation,
        "plan-1",
      );
      const second = proposalRecipe(
        created.project,
        created.foundation,
        "plan-2",
        first.proposal,
        2,
      );
      await f.first.foundation.commitProposal(first);
      await f.first.foundation.commitProposal(second);
      assert.deepEqual(
        await f.first.foundation.loadFoundation(scope),
        created.foundation,
      );
      assert.deepEqual(
        await f.first.foundation.listProposals({
          ...scope,
          afterRevision: 0,
          limit: 1,
        }),
        { proposals: [first.proposal], nextRevision: 1 },
      );
      assert.deepEqual(
        await f.first.foundation.listProposals({
          ...scope,
          afterRevision: 1,
          limit: 1,
        }),
        { proposals: [second.proposal], nextRevision: null },
      );
      assert.deepEqual(
        await f.first.foundation.loadProposal({ ...scope, revision: 1 }),
        first.proposal,
      );
      const third = proposalRecipe(
        created.project,
        created.foundation,
        "plan-3",
        second.proposal,
        3,
      );
      const before = await f.counts();
      await assert.rejects(
        f.first.foundation.commitProposal({
          ...third,
          proposal: {
            ...third.proposal,
            contentDigest: digester.sha256("text-only"),
          },
        }),
      );
      await assert.rejects(
        f.first.foundation.commitProposal({
          ...third,
          proposal: withDigest({ ...third.proposal, revision: 4 }),
        }),
      );
      for (const limit of [0, 51])
        await assert.rejects(
          f.first.foundation.listProposals({
            ...scope,
            afterRevision: 0,
            limit,
          }),
        );
      assert.deepEqual(await f.counts(), before);
    },
  );

  test(
    `${backend}: confirmation uses a real stored proposal and rejects forged dependencies`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const created = await f.first.foundation.commitCreation(
        foundationCreationRecipe("confirm", "create-confirm", "novel"),
      );
      const candidate = proposalRecipe(
        created.project,
        created.foundation,
        "proposal",
      );
      const confirm = confirmationRecipe(
        created.project,
        created.foundation,
        candidate.proposal,
        "confirm-proposal",
      );
      await assert.rejects(f.first.foundation.commitFoundationChange(confirm));
      await f.first.foundation.commitProposal(candidate);
      for (const proposal of [
        withDigest({ ...candidate.proposal, text: "伪造的未保存方案" }),
        withDigest({
          ...candidate.proposal,
          parametersRevision: 2,
          foundationRevision: 2,
        }),
        withDigest({
          ...candidate.proposal,
          source: { revision: 2, digest: digester.sha256("unstored-source") },
        }),
      ])
        await assert.rejects(
          f.first.foundation.commitFoundationChange({
            ...confirm,
            receipt: receipt(`forged-${proposal.contentDigest}`),
            proposal,
          }),
        );
      assert.deepEqual(
        await f.first.foundation.loadFoundation({
          owner: owner(),
          projectId: "confirm",
        }),
        created.foundation,
      );
      const result = await f.first.foundation.commitFoundationChange(confirm);
      assert.equal(result.foundation.revision, 2);
      assert.deepEqual(result.foundation.confirmedProposal, {
        revision: candidate.proposal.revision,
        digest: candidate.proposal.contentDigest,
      });
      assert.deepEqual(
        await f.first.foundation.commitFoundationChange(confirm),
        { ...result, disposition: "replayed" },
      );
      assert.equal(await f.count("project_proposals"), 1);
    },
  );

  test(
    `${backend}: parameter and source CAS invalidate confirmation while retaining pinned history`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const created = await f.first.foundation.commitCreation(
        foundationCreationRecipe("history", "create-history", "novel"),
      );
      const scope = { owner: owner(), projectId: "history" };
      const p1 = proposalRecipe(
        created.project,
        created.foundation,
        "history-plan-1",
      );
      await f.first.foundation.commitProposal(p1);
      const confirmed = await f.first.foundation.commitFoundationChange(
        confirmationRecipe(
          created.project,
          created.foundation,
          p1.proposal,
          "history-confirm-1",
        ),
      );
      const update = parameterChangeRecipe(
        created.project,
        confirmed.foundation,
        "history-parameters",
        3,
      );
      const updated = await f.first.foundation.commitFoundationChange(update);
      assert.equal(updated.foundation.revision, 3);
      assert.equal(updated.foundation.parametersRevision, 2);
      assert.equal(updated.foundation.confirmedProposal, null);
      await assert.rejects(
        f.first.foundation.commitFoundationChange({
          ...update,
          receipt: receipt("stale-cas"),
        }),
      );
      const p2 = proposalRecipe(
        created.project,
        updated.foundation,
        "history-plan-2",
        p1.proposal,
        4,
      );
      await f.first.foundation.commitProposal(p2);
      const confirm2 = await f.first.foundation.commitFoundationChange(
        confirmationRecipe(
          created.project,
          updated.foundation,
          p2.proposal,
          "history-confirm-2",
          4,
        ),
      );
      const source2 = sourceChangeRecipe(
        created.project,
        confirm2.foundation,
        "history-source-2",
        2,
        5,
      );
      const appended = await f.first.foundation.commitFoundationChange(source2);
      assert.equal(appended.foundation.revision, 5);
      assert.equal(appended.foundation.confirmedProposal, null);
      assert.equal(appended.foundation.parametersRevision, 2);
      assert.deepEqual(
        await f.first.foundation.loadSource({ ...scope, revision: 1 }),
        created.source,
      );
      assert.deepEqual(
        await f.first.foundation.loadSource({ ...scope, revision: 2 }),
        source2.source,
      );
      assert.deepEqual(
        await f.first.foundation.loadProposal({ ...scope, revision: 1 }),
        p1.proposal,
      );
      assert.deepEqual(
        await f.first.foundation.loadProposal({ ...scope, revision: 2 }),
        p2.proposal,
      );
      const stale = confirmationRecipe(
        created.project,
        updated.foundation,
        p2.proposal,
        "stale-confirm",
        6,
      );
      await assert.rejects(f.first.foundation.commitFoundationChange(stale));
      const forged = withDigest({
        ...p2.proposal,
        foundationRevision: appended.foundation.revision,
      });
      const invalidConfirm = {
        ...stale,
        expectedFoundationRevision: appended.foundation.revision,
        foundation: {
          ...appended.foundation,
          revision: 6,
          confirmedProposal: {
            revision: forged.revision,
            digest: forged.contentDigest,
          },
          updatedAt: time(6),
        },
        proposal: forged,
        receipt: receipt("forged-current-source"),
      };
      await assert.rejects(
        f.first.foundation.commitFoundationChange(invalidConfirm),
      );
      const oldPage = await f.first.foundation.readSourcePage({
        ...scope,
        revision: 1,
        digest: created.source!.digest,
        startOffset: 1,
        limit: 5,
      });
      assert.equal(
        oldPage.content,
        Array.from(sourceBundle(created.project).text).slice(1, 6).join(""),
      );
      const newPage = await f.first.foundation.readSourcePage({
        ...scope,
        revision: 2,
        digest: source2.source!.digest,
        startOffset: 0,
        limit: 1_024,
      });
      assert.equal(
        newPage.content,
        source2.chunks.map((chunk) => chunk.content).join(""),
      );
    },
  );

  test(
    `${backend}: original rename/archive APIs remain authoritative for new writes`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const created = await f.first.foundation.commitCreation(
        foundationCreationRecipe("interoperability"),
      );
      const old = application(f.first.projects, "existing", {
        at: time(2),
      }).service;
      const rename = await old.renameProject(actor, {
        projectId: created.project.projectId,
        title: "新的项目名",
        expectedProjectRevision: created.project.revision,
        idempotencyKey: "rename",
      });
      await assert.rejects(
        f.first.foundation.commitProposal(
          proposalRecipe(
            created.project,
            created.foundation,
            "stale-project",
            null,
            3,
          ),
        ),
      );
      const saved = await f.first.foundation.commitProposal(
        proposalRecipe(
          rename.project,
          created.foundation,
          "renamed-project",
          null,
          3,
        ),
      );
      assert.equal(saved.project.title, "新的项目名");
      assert.deepEqual(saved.foundation, created.foundation);
      const archived = await old.setProjectState(actor, {
        projectId: rename.project.projectId,
        state: "archived",
        expectedProjectRevision: rename.project.revision,
        idempotencyKey: "archive",
      });
      const before = await f.counts();
      await assert.rejects(
        f.first.foundation.commitFoundationChange(
          parameterChangeRecipe(
            rename.project,
            created.foundation,
            "archived-change",
            4,
          ),
        ),
      );
      assert.deepEqual(
        await f.first.projects.loadProject({
          owner: owner(),
          projectId: archived.project.projectId,
        }),
        archived.project,
      );
      assert.deepEqual(await f.counts(), before);
    },
  );

  test(
    `${backend}: direct script is an explicit persisted choice and remains separate from proposal confirmation`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const created = await f.first.foundation.commitCreation(
        foundationCreationRecipe("direct"),
      );
      const foundation = setProjectFoundationCreativeStartMode({
        project: created.project,
        foundation: created.foundation,
        actor,
        expectedFoundationRevision: 1,
        creativeStartMode: "direct-script",
        at: time(1),
      });
      const result = await f.first.foundation.commitFoundationChange({
        actor,
        receipt: receipt("direct-mode"),
        kind: "choose-direct-script",
        expectedFoundationRevision: 1,
        foundation,
        source: null,
        chunks: [],
        chapters: [],
        proposal: null,
      });
      assert.equal(result.foundation.revision, 2);
      assert.equal(result.foundation.creativeStartMode, "direct-script");
      assert.equal(result.foundation.confirmedProposal, null);
      assert.deepEqual(
        await f.first.foundation.loadFoundation({
          owner: owner(),
          projectId: "direct",
        }),
        foundation,
      );
    },
  );

  test(
    `${backend}: failures after brief, foundation, source and receipt inserts roll back every creation record`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      for (const table of [
        "creative_project_briefs",
        "project_foundations",
        "project_sources",
        "project_source_chunks",
        "project_foundation_mutation_receipts",
      ]) {
        const input = foundationCreationRecipe(
          `rollback-${table}`,
          `rollback-${table}`,
          "novel",
        );
        const before = await f.counts();
        let injected = false;
        f.first.hooks.afterStatement = (sql) => {
          if (
            new RegExp(
              `INSERT\\s+INTO\\s+(?:"[^"]+"\\.)?${table}\\b`,
              "i",
            ).test(sql)
          ) {
            injected = true;
            throw new Error(`injected after ${table}`);
          }
        };
        await assert.rejects(
          f.first.foundation.commitCreation(input),
          new RegExp(`injected after ${table}`),
        );
        assert.equal(injected, true);
        f.first.hooks.afterStatement = null;
        assert.deepEqual(await f.counts(), before);
        assert.equal(
          await f.first.foundation.loadMutationReceipt({
            actor,
            kind: "create-project",
            receipt: input.receipt,
          }),
          null,
        );
        assert.equal(
          (await f.first.foundation.commitCreation(input)).disposition,
          "committed",
        );
      }
    },
  );

  test(
    `${backend}: withdrawal after SQL writes and before COMMIT rolls back without leaking a receipt`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const input = foundationCreationRecipe(
        "withdraw-before",
        "withdraw-before",
        "novel",
      );
      const { state, authority } = ordinaryAuthority();
      const before = await f.counts();
      f.first.hooks.afterStatement = (sql) => {
        if (
          /INSERT\s+INTO\s+(?:"[^"]+"\.)?project_foundation_mutation_receipts\b/i.test(
            sql,
          )
        )
          state.active = false;
      };
      await assert.rejects(
        f.first.foundation.commitCreation(input, { authority }),
        /authority withdrawn/,
      );
      f.first.hooks.afterStatement = null;
      assert.deepEqual(await f.counts(), before);
      assert.ok(state.currentCalls >= 1);
      state.active = true;
      assert.equal(
        await f.first.foundation.loadMutationReceipt(
          { actor, kind: "create-project", receipt: input.receipt },
          { authority },
        ),
        null,
      );
    },
  );

  test(
    `${backend}: authority/store withdrawal after confirmed COMMIT still returns the committed snapshot`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const input = foundationCreationRecipe(
        "withdraw-after",
        "withdraw-after",
        "novel",
      );
      const { state, authority } = ordinaryAuthority();
      f.first.hooks.afterStatement = (sql) => {
        if (sql.trim().toUpperCase() === "COMMIT") {
          state.active = false;
          f.first.withdraw();
        }
      };
      const result = await f.first.foundation.commitCreation(input, {
        authority,
      });
      assert.equal(state.active, false);
      assert.equal(result.disposition, "committed");
      assert.deepEqual(result.foundation, input.foundation);
      const reopened = await f.open();
      assert.deepEqual(
        await reopened.foundation.loadMutationReceipt({
          actor,
          kind: "create-project",
          receipt: input.receipt,
        }),
        { ...result, disposition: "replayed" },
      );
      assert.equal(await f.count("project_foundation_mutation_receipts"), 1);
    },
  );

  test(
    `${backend}: close/reopen restores original projects, foundation, source, proposals and receipts`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const input = foundationCreationRecipe(
        "reopen",
        "create-reopen",
        "novel",
      );
      const created = await f.first.foundation.commitCreation(input);
      const candidate = proposalRecipe(
        created.project,
        created.foundation,
        "reopen-proposal",
      );
      await f.first.foundation.commitProposal(candidate);
      const confirmed = await f.first.foundation.commitFoundationChange(
        confirmationRecipe(
          created.project,
          created.foundation,
          candidate.proposal,
          "reopen-confirm",
        ),
      );
      await f.first.close();
      const reopened = await f.open();
      const scope = { owner: owner(), projectId: "reopen" };
      assert.deepEqual(
        await reopened.projects.loadProject(scope),
        created.project,
      );
      assert.deepEqual(
        await reopened.foundation.loadFoundation(scope),
        confirmed.foundation,
      );
      assert.deepEqual(
        await reopened.foundation.loadSource({ ...scope, revision: 1 }),
        input.source,
      );
      assert.deepEqual(
        await reopened.foundation.loadProposal({ ...scope, revision: 1 }),
        candidate.proposal,
      );
      assert.deepEqual(await reopened.foundation.commitCreation(input), {
        ...created,
        disposition: "replayed",
      });
      assert.deepEqual(
        await reopened.foundation.loadFoundation(scope),
        confirmed.foundation,
      );
      assert.equal(await f.count("creative_projects"), 1);
      assert.equal(await f.count("project_foundation_mutation_receipts"), 3);
    },
  );

  test(
    `${backend}: immutable source SQL and chunk digest verification protect pinned pages`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const input = foundationCreationRecipe(
        "digests",
        "create-digests",
        "novel",
      );
      await f.first.foundation.commitCreation(input);
      for (const table of [
        "project_sources",
        "project_source_chunks",
        "project_source_chapters",
        "project_proposals",
        "project_foundation_mutation_receipts",
      ]) {
        if (table === "project_proposals")
          await f.first.foundation.commitProposal(
            proposalRecipe(input.project, input.foundation, "digest-proposal"),
          );
        await assert.rejects(
          f.execute(`DELETE FROM ${f.prefix}${table}`),
          /immutable/,
        );
      }
      const corrupt = foundationCreationRecipe(
        "bad-digest",
        "bad-digest",
        "novel",
      );
      await assert.rejects(
        f.first.foundation.commitCreation({
          ...corrupt,
          chunks: corrupt.chunks.map((chunk, i) =>
            i === 0
              ? { ...chunk, digest: digester.sha256("other-content") }
              : chunk,
          ),
        }),
      );
      assert.equal(await f.count("creative_projects"), 1);
      // Fault injection is restricted to this disposable database. Restore its integrity trigger
      // before reading, so a corrupt content hash (rather than an absent guard) causes rejection.
      if (backend === "sqlite") {
        await f.execute("DROP TRIGGER project_source_chunks_no_update");
        await f.execute(
          "UPDATE project_source_chunks SET content='雪😀夜\n' WHERE chunk_index=0",
        );
        await f.execute(
          "CREATE TRIGGER project_source_chunks_no_update BEFORE UPDATE ON project_source_chunks BEGIN SELECT RAISE(ABORT,'project_foundation_history_immutable'); END",
        );
      } else {
        await f.execute(
          `ALTER TABLE ${f.prefix}project_source_chunks DISABLE TRIGGER project_source_chunks_immutable`,
        );
        await f.execute(
          `UPDATE ${f.prefix}project_source_chunks SET content='雪😀夜\n' WHERE chunk_index=0`,
        );
        await f.execute(
          `ALTER TABLE ${f.prefix}project_source_chunks ENABLE TRIGGER project_source_chunks_immutable`,
        );
      }
      await assert.rejects(
        f.first.foundation.readSourcePage({
          owner: owner(),
          projectId: "digests",
          revision: 1,
          digest: input.source!.digest,
          startOffset: 0,
          limit: 3,
        }),
      );
    },
  );

  test(
    `${backend}: concurrent changes admit exactly one foundation CAS winner`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const created = await f.first.foundation.commitCreation(
        foundationCreationRecipe("concurrent"),
      );
      const second = await f.open();
      const results = await Promise.allSettled([
        f.first.foundation.commitFoundationChange(
          parameterChangeRecipe(created.project, created.foundation, "cas-a"),
        ),
        second.foundation.commitFoundationChange(
          parameterChangeRecipe(created.project, created.foundation, "cas-b"),
        ),
      ]);
      assert.equal(
        results.filter((result) => result.status === "fulfilled").length,
        1,
      );
      assert.equal(
        results.filter((result) => result.status === "rejected").length,
        1,
      );
      assert.equal(
        (await f.first.foundation.loadFoundation({
          owner: owner(),
          projectId: "concurrent",
        }))!.revision,
        2,
      );
      assert.equal(await f.count("project_foundation_mutation_receipts"), 2);
      assert.equal(await f.count(foundationTables[0]), 1);
    },
  );
}
