import assert from "node:assert/strict";
import test from "node:test";
import { ApplicationError } from "./application-error.ts";
import type { ExtensionStore } from "./extension-store-port.ts";
import {
  taskActor,
  taskDigester,
} from "./extension-plugin-task.test-support.ts";
import {
  readinessDeferred,
  readinessFixture,
} from "./project-generation-readiness-application-service.test-support.ts";

test("actual Task App checks saved source, current installed configuration/runtime and credit support without writing or quoting", async () => {
  const r = readinessFixture();
  assert.deepEqual(await r.read(), {
    reference: r.input.reference,
    readiness: { outcome: "ready" },
  });
  assert.ok(
    r.f.state.projectPermissions.every(
      (value) => value === "creativeProject:write",
    ),
  );
  assert.ok(
    r.f.base.state.permissions.every((value) => value === "extension:run"),
  );
  assert.equal(r.state.evaluates, 1);
  assert.equal(r.state.transaction, 0);
  assert.equal(r.f.base.state.quoteCalls, 0);
  assert.equal(r.f.base.state.ids, 0);
  assert.equal(r.f.base.state.clocks, 0);
  assert.equal(r.f.base.state.receiptReads, 0);
  assert.equal(r.f.base.state.admissionReads, 0);
  assert.equal(r.f.base.state.commits.length, 0);
  assert.equal(r.f.state.linkReads, 0);
});

test("read source pin keeps the actual read action; forged generate pin, owner, target publication and unknown fields fail before reads", async () => {
  for (const patch of [
    {
      sourcePin: {
        ...readinessFixture().input.sourcePin,
        action: "crewon.project-generations.v1.generateConcept",
      },
    },
    { actor: { ...taskActor, principalId: "another-owner" } },
    {
      executionPin: {
        ...readinessFixture().input.executionPin,
        profileId: "another-profile",
      },
    },
    { target: "browser-selected-target" },
  ]) {
    const r = readinessFixture();
    await assert.rejects(
      r
        .create()
        .getPublishedProjectGenerationReadiness({ ...r.input, ...patch }),
    );
    assert.equal(r.f.state.projectReads.length, 0);
    assert.equal(r.state.evaluates, 0);
  }
});

test("rejects reference and callback accessors without evaluating them", async () => {
  const r = readinessFixture();
  let getters = 0;
  const reference = { ...r.input.reference };
  Object.defineProperty(reference, "assetId", {
    enumerable: true,
    get() {
      getters++;
      return "untrusted";
    },
  });
  await assert.rejects(
    r
      .create()
      .getPublishedProjectGenerationReadiness({ ...r.input, reference }),
  );
  const authority = { ...r.authority };
  Object.defineProperty(authority, "assertCurrent", {
    enumerable: true,
    get() {
      getters++;
      return () => {};
    },
  });
  await assert.rejects(
    r
      .create()
      .getPublishedProjectGenerationReadiness({ ...r.input, authority }),
  );
  assert.equal(getters, 0);
  assert.equal(r.f.state.projectReads.length, 0);
});

test("captures input and callback receiver before first await; later replacements cannot alter the reply", async () => {
  const r = readinessFixture();
  const gate = readinessDeferred(),
    entered = readinessDeferred();
  r.state.onCurrent = async () => {
    r.state.onCurrent = null;
    entered.resolve();
    await gate.promise;
  };
  const input = {
    ...r.input,
    reference: { ...r.input.reference },
    publication: structuredClone(r.input.publication),
    sourcePin: { ...r.input.sourcePin },
  };
  const pending = r.create().getPublishedProjectGenerationReadiness(input);
  await entered.promise;
  input.reference.assetId = "changed";
  input.publication.target.pluginId = "changed-target";
  input.sourcePin.pluginId = "changed-source";
  r.authority.assertCurrent = async () => {
    throw new Error("replacement-must-not-run");
  };
  gate.resolve();
  assert.deepEqual(await pending, {
    reference: r.input.reference,
    readiness: { outcome: "ready" },
  });
});

for (const change of ["missing", "cas", "archive"] as const)
  test(`${change} saved source is input-unavailable and never evaluated`, async () => {
    const r = readinessFixture();
    if (change === "archive") r.f.archive();
    const reference =
      change === "missing"
        ? { ...r.input.reference, assetId: "missing" }
        : change === "cas"
          ? { ...r.input.reference, expectedAssetMetadataRevision: 77 }
          : r.input.reference;
    assert.deepEqual(
      await r
        .create()
        .getPublishedProjectGenerationReadiness({ ...r.input, reference }),
      {
        reference,
        readiness: {
          outcome: "unavailable",
          reasonCode: "project_generation_input_unavailable",
        },
      },
    );
    assert.equal(r.state.evaluates, 0);
  });

for (const denied of ["project", "extension", "host"] as const)
  test(`${denied} authority rejection stays an error`, async () => {
    const r = readinessFixture();
    if (denied === "project") r.f.state.deniedProject = true;
    if (denied === "extension") r.f.base.state.denied = "extension:run";
    if (denied === "host") r.state.live = false;
    await assert.rejects(
      r.read(),
      (error: unknown) =>
        error instanceof ApplicationError && error.category === "authorization",
    );
    assert.equal(r.state.evaluates, 0);
  });

for (const missing of [
  "projects",
  "publication",
  "credits",
  "quotes",
  "installed-mode",
  "configuration",
  "registration",
] as const)
  test(`${missing} support is configuration-unavailable without quotes or execution`, async () => {
    const r = readinessFixture();
    const patch =
      missing === "projects"
        ? { creativeProjects: undefined }
        : missing === "publication"
          ? {
              extensions: {
                ...r.extensions,
                projectGenerationPublicationVersion: undefined,
              },
            }
          : missing === "credits"
            ? {
                extensions: {
                  ...r.extensions,
                  creditAdmissionVersion: undefined,
                },
              }
            : missing === "quotes"
              ? { creditQuotes: undefined }
              : missing === "installed-mode"
                ? {
                    host: {
                      ...r.host,
                      taskAdmissionMode: () => "legacy" as const,
                    },
                  }
                : missing === "configuration"
                  ? {
                      extensions: {
                        ...r.extensions,
                        loadExtensionConfiguration: async () => null,
                      },
                    }
                  : {
                      catalog: {
                        ...r.f.base.dependencies.catalog,
                        resolve: () => null,
                      },
                    };
    assert.deepEqual(
      await r.create(patch).getPublishedProjectGenerationReadiness(r.input),
      {
        reference: r.input.reference,
        readiness: {
          outcome: "unavailable",
          reasonCode: "project_generation_configuration_unavailable",
        },
      },
    );
    assert.equal(r.state.evaluates, 0);
    assert.equal(r.f.base.state.quoteCalls, 0);
  });

test("host unavailability and exact target mismatch become runtime-unavailable without exposing the target", async () => {
  for (const mismatch of [false, true]) {
    const r = readinessFixture();
    const original = await r.host.evaluate({} as never);
    assert.equal(original.outcome, "ready");
    const host = {
      ...r.host,
      evaluate: async () =>
        mismatch && original.outcome === "ready"
          ? {
              outcome: "ready" as const,
              target: { ...original.target, authorityId: "other-authority" },
            }
          : {
              outcome: "unavailable" as const,
              reasonCode: "extension_runtime_unavailable" as const,
            },
    };
    const result = await r
      .create({ host })
      .getPublishedProjectGenerationReadiness(r.input);
    assert.deepEqual(result, {
      reference: r.input.reference,
      readiness: {
        outcome: "unavailable",
        reasonCode: "project_generation_runtime_unavailable",
      },
    });
    assert.equal(JSON.stringify(result).includes("agentVersion"), false);
  }
});

for (const change of [
  "input",
  "archive",
  "activation",
  "policy",
  "close",
] as const)
  test(`readiness await cannot preserve ${change} withdrawn current state`, async () => {
    const r = readinessFixture();
    const entered = readinessDeferred(),
      gate = readinessDeferred();
    let activationChanged = false;
    const original = r.extensions.loadExtensionActivation.bind(r.extensions);
    const extensions: ExtensionStore = {
      ...r.extensions,
      async loadExtensionActivation(input) {
        const value = await original(input);
        assert.ok(value);
        return activationChanged
          ? {
              ...value,
              revision: value.revision + 1,
              state: "disabled" as const,
              target: null,
            }
          : value;
      },
    };
    r.state.onEvaluate = async () => {
      entered.resolve();
      await gate.promise;
    };
    const pending = r
      .create({ extensions })
      .getPublishedProjectGenerationReadiness(r.input);
    void pending.catch(() => {});
    await entered.promise;
    if (change === "input") r.f.appendInput();
    if (change === "archive") r.f.archive();
    if (change === "activation") activationChanged = true;
    if (change === "policy") r.f.state.deniedProject = true;
    if (change === "close") r.state.live = false;
    gate.resolve();
    if (change === "policy" || change === "close")
      await assert.rejects(
        pending,
        (error: unknown) =>
          error instanceof ApplicationError &&
          error.category === "authorization",
      );
    else
      assert.deepEqual((await pending).readiness, {
        outcome: "unavailable",
        reasonCode:
          change === "activation"
            ? "project_generation_configuration_unavailable"
            : "project_generation_input_unavailable",
      });
    assert.equal(r.f.base.state.quoteCalls, 0);
    assert.equal(r.f.base.state.commits.length, 0);
  });

test("revoked original activation and corrupt saved digest remain errors", async () => {
  const r = readinessFixture();
  const original = await r.extensions.loadExtensionActivation({
    tenantId: taskActor.tenantId,
    spaceId: taskActor.spaceId,
    pluginId: r.input.executionPin.pluginId,
  });
  assert.ok(original);
  await assert.rejects(
    r
      .create({
        extensions: {
          ...r.extensions,
          loadExtensionActivation: async () => ({
            ...original,
            state: "revoked" as const,
            target: null,
          }),
        },
      })
      .getPublishedProjectGenerationReadiness(r.input),
    (error: unknown) =>
      error instanceof ApplicationError && error.category === "authorization",
  );
  r.f.state.revisions.set(1, {
    ...r.f.original.assetRevision,
    contentDigest: taskDigester.sha256("wrong-content"),
  });
  await assert.rejects(
    r.read(),
    (error: unknown) =>
      error instanceof ApplicationError && error.category === "internal",
  );
});
