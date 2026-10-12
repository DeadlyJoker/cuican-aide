import assert from "node:assert/strict";
import test from "node:test";
import { projectToolsOwnerFixture } from "./project-tools-service-owner.test-support.ts";
import { foundationMetadataFixture } from "../../../packages/store/src/project-foundation-legacy-access.test-support.ts";

// Genuine original Run/Tool/claim and SQL stores. The immutable owner row is
// a constraint fixture; it must never become an execution or adoption grant.
for (const foreign of [false, true])
  test(`ordinary Worker project tools cannot borrow ${foreign ? "another plugin's" : "their own"} protected project through installation trust`, async (t) => {
    const f = await projectToolsOwnerFixture(t);
    const metadata = await foundationMetadataFixture(t, {
      backend: "sqlite",
      schema: "main",
      prefix: "",
      path: f.databasePath,
    });
    await metadata.migrate();
    const ownerScope = {
      ...f.actor,
      profileId: f.admission.profileId,
      pluginId: foreign ? "foreign.protected" : f.admission.pluginId,
      publisherId: f.admission.publisherId,
    };
    const request = { projectId: f.reference.projectId };
    const operation = await f.prepareRead("readProject", request);
    const owner = f.owner();
    const service = f.service(owner);
    const before = await f.invoke(owner, operation, (command) =>
      service.readProject({ command, request }),
    );
    assert.equal(before.project.projectId, request.projectId);
    await metadata.mark(request.projectId, ownerScope);
    const counts = await f.counts();
    await assert.rejects(
      f.invoke(owner, operation, (command) =>
        service.readProject({ command, request }),
      ),
      /creative_project_not_found/,
    );
    await owner.close();
    const cold = f.owner();
    await assert.rejects(
      f.invoke(cold, operation, (command) =>
        f.service(cold).readProject({ command, request }),
      ),
      /creative_project_not_found/,
    );
    const contentRequest = {
      projectId: request.projectId,
      source: { kind: "brief" as const, briefRevision: 1 },
      offset: 0,
    };
    const content = await f.prepareRead("readContent", contentRequest);
    await assert.rejects(
      f.invoke(cold, content, (command) =>
        f.service(cold).readContent({ command, request: contentRequest }),
      ),
      /creative_project_not_found/,
    );
    assert.deepEqual(await f.counts(), {
      ...counts,
      // Preparing the second real read adds its original Tool receipt only.
      tool_execution_receipts: counts.tool_execution_receipts + 1,
    });
  });
