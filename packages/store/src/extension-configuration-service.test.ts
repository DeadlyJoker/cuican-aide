import assert from "node:assert/strict";
import test from "node:test";
import {
  ApplicationError,
  type ExtensionReadiness,
  type SaveExtensionConfigurationCommand,
} from "@crewon/application";
import {
  actor,
  activateCommand,
  configurationServiceFixture,
  saveCommand,
} from "./extension-configuration-service.test-support.ts";
import { digest, scope, target } from "./extension-store.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const skip =
    backend === "postgres" &&
    process.env.CREWON_TEST_POSTGRES_URL === undefined;
  test(
    `${backend} extension configuration service: authorized snapshots bind catalog identity and explicit deployed target`,
    { skip },
    async (t) => {
      const f = await configurationServiceFixture(t, backend);
      await f.seedDeployment();
      const saved = await f.service.saveConfiguration(actor, saveCommand);
      assert.equal(saved.configuration.manifestDigest, f.state.catalogDigest);
      assert.equal(
        saved.configuration.implementationDigest,
        f.state.implementationDigest,
      );
      assert.deepEqual(f.state.permissions[0], {
        actor,
        action: "extension:configure",
        resource: { kind: "extension", ...scope },
      });
      assert.deepEqual(
        f.state.validated[0]?.configuration,
        saved.configuration,
      );
      const enabled = await f.service.setActivation(actor, activateCommand);
      assert.deepEqual(enabled.activation.target, target);
      assert.equal(
        enabled.activation.configurationDigest,
        saved.configuration.contentDigest,
      );
      assert.equal(
        f.state.evaluated[0]?.agentVersionId,
        activateCommand.agentVersionId,
      );
      assert.deepEqual(
        await f.service.getConfiguration(actor, {
          pluginId: scope.pluginId,
          revision: null,
        }),
        saved.configuration,
      );
      assert.deepEqual(
        await f.service.getConfiguration(actor, {
          pluginId: scope.pluginId,
          revision: 1,
        }),
        saved.configuration,
      );
      assert.deepEqual(
        await f.service.getActivation(actor, scope.pluginId),
        enabled.activation,
      );
      assert.equal(
        await f.count("run_snapshots"),
        0,
        "configuration never creates or switches a Run",
      );
    },
  );

  test(
    `${backend} extension configuration service: permissions precede metadata access and every receipt replay`,
    { skip },
    async (t) => {
      const f = await configurationServiceFixture(t, backend);
      f.state.denied = "extension:configure";
      await assert.rejects(
        f.service.saveConfiguration(actor, saveCommand),
        code("authorization_denied"),
      );
      assert.equal(f.state.validated.length, 0);
      assert.equal(await f.count("extension_configurations"), 0);
      f.state.denied = null;
      const saved = await f.service.saveConfiguration(actor, saveCommand);
      f.state.denied = "extension:configure";
      await assert.rejects(
        f.service.saveConfiguration(actor, saveCommand),
        code("authorization_denied"),
      );
      f.state.denied = "extension:read";
      await assert.rejects(
        f.service.getConfiguration(actor, {
          pluginId: scope.pluginId,
          revision: null,
        }),
        code("authorization_denied"),
      );
      await assert.rejects(
        f.service.getActivation(actor, scope.pluginId),
        code("authorization_denied"),
      );
      f.state.denied = "extension:activate";
      await assert.rejects(
        f.service.setActivation(actor, activateCommand),
        code("authorization_denied"),
      );
      assert.equal(f.state.evaluated.length, 0);
      f.state.denied = null;
      f.state.authorizationError = new Error(
        "upstream-secret-must-not-be-public",
      );
      await assert.rejects(
        f.service.saveConfiguration(actor, saveCommand),
        code("authorization_unavailable"),
      );
      assert.equal(saved.configuration.revision, 1);
    },
  );

  test(
    `${backend} extension configuration service: rejects unknown fields, raw secrets and unrecognized credential slots`,
    { skip },
    async (t) => {
      const f = await configurationServiceFixture(t, backend);
      for (const patch of [
        { tenantId: "other-tenant" },
        { implementationDigest: digest },
        { target },
        { parameters: { format: "mp4", apiKey: "secret" } },
        { parameters: { format: "unsupported" } },
        {
          credentialBindings: [
            { slotId: "unknown", credentialBindingId: "credential-1" },
          ],
        },
        {
          credentialBindings: [
            {
              slotId: "provider",
              credentialBindingId: "credential-1",
              secret: "raw",
            },
          ],
        },
        {
          credentialBindings: [
            ...saveCommand.credentialBindings,
            ...saveCommand.credentialBindings,
          ],
        },
        { expectedRevision: -1 },
        { parameters: { format: "x".repeat(16_384) } },
      ])
        await assert.rejects(
          f.service.saveConfiguration(actor, {
            ...saveCommand,
            ...patch,
          } as SaveExtensionConfigurationCommand),
          (error: unknown) =>
            error instanceof ApplicationError &&
            error.category === "validation",
        );
      assert.equal(await f.count("extension_configurations"), 0);
      assert.equal(f.state.validated.length, 0);
      f.state.validationError = new ApplicationError(
        "authorization",
        "credential_binding_forbidden",
      );
      await assert.rejects(
        f.service.saveConfiguration(actor, saveCommand),
        code("credential_binding_forbidden"),
      );
      assert.equal(await f.count("extension_configurations"), 0);
    },
  );

  test(
    `${backend} extension configuration service: actor and command cannot change while authorization is pending`,
    { skip },
    async (t) => {
      const f = await configurationServiceFixture(t, backend);
      let release!: () => void;
      f.state.authorizationGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const input = structuredClone(saveCommand);
      const caller = { ...actor };
      const pending = f.service.saveConfiguration(caller, input);
      (input.parameters as { format: string }).format = "webm";
      caller.spaceId = "changed-space";
      release();
      const result = await pending;
      assert.equal(result.configuration.spaceId, actor.spaceId);
      assert.equal(result.configuration.parameters.format, "mp4");
      assert.equal(
        await f.service.getConfiguration(caller, {
          pluginId: scope.pluginId,
          revision: 1,
        }),
        null,
      );
    },
  );

  test(
    `${backend} extension configuration service: offline retry returns original receipt without revalidating mutable runtime`,
    { skip },
    async (t) => {
      const f = await configurationServiceFixture(t, backend);
      await f.seedDeployment();
      const saved = await f.service.saveConfiguration(actor, saveCommand);
      const activated = await f.service.setActivation(actor, activateCommand);
      f.state.catalogAvailable = false;
      f.state.validationError = new Error("host-offline");
      f.state.readiness = {
        outcome: "unavailable",
        reasonCode: "extension_runtime_unavailable",
      };
      const disabled = await f.service.setActivation(actor, {
        ...activateCommand,
        expectedRevision: 1,
        idempotencyKey: "disable",
        state: "disabled",
        agentVersionId: null,
      });
      assert.equal(disabled.activation.state, "disabled");
      assert.deepEqual(await f.service.saveConfiguration(actor, saveCommand), {
        ...saved,
        disposition: "replayed",
      });
      assert.deepEqual(await f.service.setActivation(actor, activateCommand), {
        ...activated,
        disposition: "replayed",
      });
      assert.equal(
        (await f.service.getActivation(actor, scope.pluginId))?.state,
        "disabled",
        "replay must not re-enable the plugin",
      );
      assert.equal(f.state.validated.length, 1);
      assert.equal(f.state.evaluated.length, 1);
      await assert.rejects(
        f.service.saveConfiguration(actor, {
          ...saveCommand,
          parameters: { format: "webm" },
        }),
        code("extension_idempotency_conflict"),
      );
      await assert.rejects(
        f.service.setActivation(actor, {
          ...activateCommand,
          state: "revoked",
          agentVersionId: null,
        }),
        code("extension_idempotency_conflict"),
      );
      f.state.denied = "extension:activate";
      await assert.rejects(
        f.service.setActivation(actor, activateCommand),
        code("authorization_denied"),
      );
    },
  );

  test(
    `${backend} extension configuration service: registration, credentials and exact runtime are separate enable gates`,
    { skip },
    async (t) => {
      const f = await configurationServiceFixture(t, backend);
      await f.seedDeployment();
      f.state.catalogAvailable = false;
      await assert.rejects(
        f.service.saveConfiguration(actor, saveCommand),
        code("extension_version_unavailable"),
      );
      f.state.catalogAvailable = true;
      const validDigest = f.state.catalogDigest;
      f.state.catalogDigest = digest;
      await assert.rejects(
        f.service.saveConfiguration(actor, saveCommand),
        code("extension_catalog_invalid"),
      );
      f.state.catalogDigest = validDigest;
      await f.service.saveConfiguration(actor, {
        ...saveCommand,
        credentialBindings: [],
      });
      await assert.rejects(
        f.service.setActivation(actor, activateCommand),
        code("extension_credential_unavailable"),
      );
      assert.equal(f.state.evaluated.length, 0);
      await f.service.saveConfiguration(actor, {
        ...saveCommand,
        expectedRevision: 1,
        idempotencyKey: "save-2",
      });
      const enable = { ...activateCommand, configurationRevision: 2 };
      f.state.readiness = {
        outcome: "unavailable",
        reasonCode: "extension_execution_authority_unsupported",
      };
      await assert.rejects(
        f.service.setActivation(actor, enable),
        code("extension_execution_authority_unsupported"),
      );
      f.state.readiness = {
        outcome: "ready",
        target: { ...target, executionAuthority: "providerAgent" },
      } as unknown as ExtensionReadiness;
      await assert.rejects(
        f.service.setActivation(actor, enable),
        code("extension_runtime_target_invalid"),
      );
      f.state.readiness = {
        outcome: "ready",
        target: { ...target, agentVersionId: "wrong-agent" },
      };
      await assert.rejects(
        f.service.setActivation(actor, enable),
        code("extension_execution_target_mismatch"),
      );
      f.state.readiness = {
        outcome: "ready",
        target: { ...target, materializationDigest: digest },
      };
      await assert.rejects(
        f.service.setActivation(actor, enable),
        code("extension_execution_target_not_deployed"),
      );
      f.state.implementationDigest = `sha256:${"b".repeat(64)}`;
      await assert.rejects(
        f.service.setActivation(actor, enable),
        code("extension_implementation_unavailable"),
      );
      assert.equal(await f.count("extension_activations"), 0);
    },
  );

  test(
    `${backend} extension configuration service: scope and revision conflicts cannot change other configuration`,
    { skip },
    async (t) => {
      const f = await configurationServiceFixture(t, backend);
      await f.seedDeployment();
      const results = await Promise.all([
        f.service.saveConfiguration(actor, saveCommand),
        f.secondService.saveConfiguration(actor, saveCommand),
      ]);
      assert.deepEqual(results.map((r) => r.disposition).sort(), [
        "created",
        "replayed",
      ]);
      await assert.rejects(
        f.service.saveConfiguration(actor, {
          ...saveCommand,
          idempotencyKey: "stale",
        }),
        code("extension_configuration_revision_conflict"),
      );
      const otherActor = { ...actor, actorId: "another-actor" };
      await assert.rejects(
        f.service.saveConfiguration(otherActor, saveCommand),
        code("extension_configuration_revision_conflict"),
      );
      for (const patch of [
        { tenantId: "other-tenant" },
        { spaceId: "other-space" },
      ]) {
        assert.equal(
          await f.service.getConfiguration(
            { ...actor, ...patch },
            { pluginId: scope.pluginId, revision: 1 },
          ),
          null,
        );
        await assert.rejects(
          f.service.setActivation({ ...actor, ...patch }, activateCommand),
          code("extension_configuration_not_found"),
        );
      }
      await f.service.setActivation(actor, activateCommand);
      await assert.rejects(
        f.service.setActivation(actor, {
          ...activateCommand,
          idempotencyKey: "stale-activation",
        }),
        code("extension_activation_revision_conflict"),
      );
      assert.equal(
        (await f.service.getActivation(actor, scope.pluginId))?.revision,
        1,
      );
    },
  );
}

function code(expected: string) {
  return (error: unknown) =>
    error instanceof ApplicationError && error.code === expected;
}
