import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual as same } from "node:util";
import { parseAgentVersionAsset } from "@crewon/agent-version";
import {
  assertExtensionCreditAdmission,
  assertPluginTaskAdmission,
  extensionCanonicalJson,
  extensionOpaqueId,
  parseExtensionActivation,
  parseExtensionConfiguration,
  parseExtensionRunBinding,
  parseInstalledPluginPackage,
  parsePluginProfileScope,
  parsePluginSelection,
  type PluginProfileScope,
} from "@crewon/domain";
import { SqliteRunStore } from "@crewon/store";
import type { DESKTOP_RUNTIME_OWNER } from "./desktopExtensionRuntime.ts";

type NativeNamedReportActor = typeof DESKTOP_RUNTIME_OWNER;

export type NativeNamedReportExecutionConfiguration = Readonly<{
  idempotencyKey: string | null;
  providerBaseUrl: string;
  subject: string;
}>;
export type NativeNamedReportExecutionDecision = Readonly<{
  action: string;
  resource: Readonly<Record<string, unknown>>;
  allowed: boolean;
  reasonCode: string;
  runId: string | null;
}>;
export type NativeNamedReportExecutionAuthority = Readonly<{
  authorizePolicy(
    input: Readonly<{
      action: string;
      resource: Record<string, unknown>;
    }>,
  ): Promise<boolean>;
  bindRequestKey(key: string): void;
  denyExecution(): void;
  readonly decisions: readonly NativeNamedReportExecutionDecision[];
}>;

const pluginId = "example.professional";
const maximumDecisions = 2048;
const digester = Object.freeze({
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
});

/** A named test PDP for one already committed, paid report. It never admits, funds or dispatches. */
export function createNativeNamedReportExecutionAuthority(
  input: Readonly<{
    databasePath: string;
    actor: NativeNamedReportActor;
    resolveProfile(): Promise<PluginProfileScope | null>;
    configuration: NativeNamedReportExecutionConfiguration;
  }>,
): NativeNamedReportExecutionAuthority {
  const actorFields = record(input.actor, [
    "principalId",
    "actorId",
    "tenantId",
    "spaceId",
  ]);
  const actor: NativeNamedReportActor = Object.freeze({
    principalId: extensionOpaqueId(actorFields.principalId),
    actorId: extensionOpaqueId(actorFields.actorId),
    tenantId: extensionOpaqueId(actorFields.tenantId),
    spaceId: extensionOpaqueId(actorFields.spaceId),
  });
  const fields = record(input.configuration, [
    "idempotencyKey",
    "providerBaseUrl",
    "subject",
  ]);
  assert.equal(typeof fields.providerBaseUrl, "string");
  assert.equal(typeof fields.subject, "string");
  const providerBaseUrl = fields.providerBaseUrl as string;
  const subject = fields.subject as string;
  assert.ok(providerBaseUrl.length > 0 && providerBaseUrl.length <= 2048);
  const endpoint = new URL(providerBaseUrl);
  const loopback = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/$/u.exec(
    providerBaseUrl,
  );
  const namedLoopbackProvider =
    loopback !== null && Number(loopback[1]) <= 65535;
  assert.ok(
    (endpoint.protocol === "https:" || namedLoopbackProvider) &&
      !endpoint.username &&
      !endpoint.password &&
      !endpoint.search &&
      !endpoint.hash,
  );
  assert.ok(subject.length > 0 && Buffer.byteLength(subject) <= 8192);
  const configuration = Object.freeze({
    idempotencyKey:
      fields.idempotencyKey === null
        ? null
        : extensionOpaqueId(fields.idempotencyKey),
    providerBaseUrl,
    subject,
  });
  const databasePath = input.databasePath;
  assert.ok(isAbsolute(databasePath) && resolve(databasePath) === databasePath);
  const resolveProfile = input.resolveProfile.bind(input);
  const decisions: NativeNamedReportExecutionDecision[] = [];
  let requestKey = configuration.idempotencyKey;
  let executionDenied = false;
  let databaseIdentity: Readonly<{ dev: number; ino: number }> | undefined;
  let parentIdentity: Readonly<{ dev: number; ino: number }> | undefined;

  function assertDatabase(): void {
    const parent = dirname(databasePath);
    const directory = lstatSync(parent);
    const database = lstatSync(databasePath);
    assert.ok(
      directory.isDirectory() &&
        !directory.isSymbolicLink() &&
        directory.uid === process.getuid?.() &&
        (directory.mode & 0o777) === 0o700 &&
        realpathSync(parent) === parent &&
        database.isFile() &&
        !database.isSymbolicLink() &&
        database.uid === process.getuid?.() &&
        database.nlink === 1 &&
        realpathSync(databasePath) === databasePath,
    );
    const currentDatabase = { dev: database.dev, ino: database.ino };
    const currentParent = { dev: directory.dev, ino: directory.ino };
    if (databaseIdentity) assert.deepEqual(currentDatabase, databaseIdentity);
    if (parentIdentity) assert.deepEqual(currentParent, parentIdentity);
    databaseIdentity ??= Object.freeze(currentDatabase);
    parentIdentity ??= Object.freeze(currentParent);
  }

  async function savedReport(
    resource: Readonly<Record<string, unknown>>,
    execution: boolean,
    idempotencyKey: string,
  ): Promise<string> {
    const current = await resolveProfile();
    assert.ok(current);
    const scope = parsePluginProfileScope(current);
    assert.equal(scope.tenantId, actor.tenantId);
    assert.equal(scope.spaceId, actor.spaceId);
    assertDatabase();
    const store = new SqliteRunStore(databasePath);
    try {
      const extensions = store.extensionStore();
      const receiptKey = `plugin-task:${digester
        .sha256(
          extensionCanonicalJson([
            actor.tenantId,
            actor.spaceId,
            scope.profileId,
            actor.principalId,
            actor.actorId,
            pluginId,
            idempotencyKey,
          ]),
        )
        .slice(7)}`;
      const admission = await extensions.loadPluginTaskAdmissionByReceipt({
        ...scope,
        pluginId,
        principalId: actor.principalId,
        actorId: actor.actorId,
        idempotencyKey: receiptKey,
      });
      assert.ok(admission);
      assert.equal(admission.version, "1.0.0");
      assert.equal(admission.contributionId, "studio");
      assert.equal(admission.action, "report.generate");
      const locator = { ...scope, runId: admission.runId };
      const rawBinding = await extensions.loadExtensionRunBinding(locator);
      assert.ok(rawBinding);
      const binding = parseExtensionRunBinding(rawBinding, digester);
      const receipt = {
        actorId: actor.actorId,
        idempotencyKey: receiptKey,
        requestDigest: admission.requestDigest,
      };
      assertPluginTaskAdmission({ admission, binding, receipt }, digester);
      if (resource.kind === "run") {
        assert.equal(resource.runId, binding.runId);
        assert.equal(resource.threadId, binding.threadId);
      }
      const saved = await extensions.loadExtensionTurnReceipt({
        ...binding,
        receipt,
      });
      assert.ok(saved?.creditAdmission);
      assert.equal(saved.schemaVersion, "crewon.extension-turn-admission.v0");
      assert.deepEqual(saved.binding, binding);
      assert.deepEqual(saved.run.state, saved.turn.runState);
      assert.deepEqual(saved.run.events, saved.turn.runEvents);
      assert.equal(saved.run.events.length, 1);
      assert.equal(saved.run.events[0]!.type, "run.created");
      assert.equal(saved.run.events[0]!.identity.runId, binding.runId);
      assert.equal(saved.turn.messages.length, 1);
      const message = saved.turn.messages[0]!;
      assert.equal(message.role, "user");
      assert.equal(message.tenantId, actor.tenantId);
      assert.equal(message.threadId, binding.threadId);
      assert.equal(message.contentDigest, binding.inputDigest);
      assert.equal(digester.sha256(message.content), binding.inputDigest);
      assert.deepEqual(JSON.parse(message.content), {
        subject: configuration.subject,
      });
      assert.equal(saved.turn.threadState.tenantId, actor.tenantId);
      assert.equal(saved.turn.threadState.spaceId, actor.spaceId);
      assert.equal(saved.turn.threadState.threadId, binding.threadId);
      const {
        schemaVersion: _schema,
        runId: _run,
        threadId: _thread,
        extensionBindingDigest: _binding,
        requestDigest: _request,
        idempotencyKey: _key,
        ...pin
      } = admission;
      assert.equal(
        admission.requestDigest,
        digester.sha256(
          extensionCanonicalJson({
            schemaVersion: "crewon.plugin-task-command.v1",
            actor,
            pin,
            command: {
              pluginId,
              threadId: binding.threadId,
              expectedThreadRevision: saved.turn.threadState.revision - 1,
              idempotencyKey,
              intent: {
                kind: "generate",
                input: { subject: configuration.subject },
              },
            },
          }),
        ),
      );
      const credit = assertExtensionCreditAdmission(
        {
          admission: saved.creditAdmission,
          binding,
          receipt,
        },
        digester,
      );
      assert.equal(credit.reservation.scope.principalId, actor.principalId);
      const reservation = await store.pluginCreditStore().getReservation({
        scope: credit.reservation.scope,
        reservationId: credit.reservation.reservationId,
      });
      assert.ok(reservation);
      for (const name of Object.keys(
        credit.reservation,
      ) as (keyof typeof credit.reservation)[])
        assert.deepEqual(reservation[name], credit.reservation[name]);
      if (execution) assert.notEqual(reservation.state, "released");
      const run = await store.loadRunInSpace(locator);
      assert.ok(run);
      for (const state of [run, saved.run.state]) {
        assert.equal(state.tenantId, actor.tenantId);
        assert.equal(state.spaceId, actor.spaceId);
        assert.equal(state.createdByActorId, actor.actorId);
        assert.equal(state.runId, binding.runId);
        assert.equal(state.threadId, binding.threadId);
        assert.equal(state.goalBinding, null);
        for (const name of [
          "agentVersionId",
          "authorityId",
          "runtimeGeneration",
          "policySnapshotId",
          "workspaceBindingId",
        ] as const)
          assert.equal(state[name], binding.target[name]);
      }
      const rawConfiguration = await extensions.loadExtensionConfiguration({
        ...binding,
        revision: binding.configurationRevision,
      });
      assert.ok(rawConfiguration);
      const publishedConfiguration = parseExtensionConfiguration(
        rawConfiguration,
        digester,
      );
      assert.equal(publishedConfiguration.tenantId, actor.tenantId);
      assert.equal(publishedConfiguration.spaceId, actor.spaceId);
      assert.equal(publishedConfiguration.pluginId, pluginId);
      assert.equal(
        publishedConfiguration.revision,
        binding.configurationRevision,
      );
      assert.equal(
        publishedConfiguration.contentDigest,
        binding.configurationDigest,
      );
      assert.equal(publishedConfiguration.pluginVersion, admission.version);
      assert.equal(
        publishedConfiguration.parameters.providerBaseUrl,
        configuration.providerBaseUrl,
      );
      const installed = await store.pluginInstallationStore().loadPackage({
        scope,
        packageDigest: admission.packageDigest,
      });
      assert.ok(installed);
      const pkg = parseInstalledPluginPackage(installed);
      for (const name of [
        "tenantId",
        "spaceId",
        "profileId",
        "pluginId",
        "publisherId",
        "version",
        "packageDigest",
      ] as const)
        assert.equal(pkg[name], admission[name]);
      const selected = await store
        .pluginInstallationStore()
        .loadSelection({ scope, pluginId });
      assert.ok(selected);
      const selection = parsePluginSelection(selected);
      assert.deepEqual(
        {
          tenantId: selection.tenantId,
          spaceId: selection.spaceId,
          profileId: selection.profileId,
        },
        scope,
      );
      assert.equal(selection.pluginId, pluginId);
      assert.equal(selection.publisherId, admission.publisherId);
      assert.ok(selection.revision >= admission.selectionRevision);
      const rawActivation = await extensions.loadExtensionActivation(binding);
      assert.ok(rawActivation);
      const activation = parseExtensionActivation(rawActivation);
      assert.equal(activation.tenantId, actor.tenantId);
      assert.equal(activation.spaceId, actor.spaceId);
      assert.equal(activation.pluginId, pluginId);
      if (execution) {
        assert.equal(selection.state, "enabled");
        assert.equal(selection.selectedPackageDigest, admission.packageDigest);
        assert.equal(activation.state, "enabled");
        assert.equal(
          activation.configurationRevision,
          binding.configurationRevision,
        );
        assert.equal(
          activation.configurationDigest,
          binding.configurationDigest,
        );
        assert.deepEqual(activation.target, binding.target);
        const latest =
          await extensions.loadLatestExtensionConfiguration(binding);
        assert.deepEqual(latest, publishedConfiguration);
      }
      const target = binding.target;
      const asset = await store.loadAgentVersion({
        ...scope,
        agentVersionId: target.agentVersionId,
      });
      const deployment = await store.loadAgentVersionDeployment({
        ...scope,
        agentVersionId: target.agentVersionId,
      });
      const active = await store.loadActiveAgentVersionRelease(scope);
      assert.ok(asset && deployment && active);
      const compiled = parseAgentVersionAsset(asset, digester);
      assert.deepEqual(target, {
        executionAuthority: "crewonKernel",
        agentVersionId: compiled.agentVersionId,
        agentVersionContentDigest: compiled.contentDigest,
        materializationDigest: deployment.materializationDigest,
        authorityId: deployment.authorityId,
        runtimeGeneration: compiled.runtimeGeneration,
        policySnapshotId: compiled.policySnapshotId,
        workspaceBindingId: deployment.workspaceBindingId,
      });
      assert.equal(deployment.contentDigest, compiled.contentDigest);
      const { deployedAt: _deployedAt, ...candidate } = deployment;
      assert.ok(
        active.bundle.deployments.some((entry) => same(entry, candidate)),
      );
      const latestProfile = await resolveProfile();
      assert.ok(latestProfile);
      assert.deepEqual(parsePluginProfileScope(latestProfile), scope);
      assertDatabase();
      return binding.runId;
    } finally {
      await store.close();
    }
  }

  return Object.freeze({
    async authorizePolicy(
      provided: Readonly<{ action: string; resource: Record<string, unknown> }>,
    ) {
      if (decisions.length >= maximumDecisions) return false;
      let action = "invalid",
        resource: Readonly<Record<string, unknown>> = Object.freeze({});
      let allowed = false,
        runId: string | null = null;
      let reasonCode = "named_report_saved_authority_unavailable";
      try {
        const request = record(provided, ["action", "resource"]);
        assert.equal(typeof request.action, "string");
        assert.ok(
          [
            "run:execute",
            "run:read",
            "extension:run",
            "extension:query",
          ].includes(request.action as string),
        );
        action = request.action as string;
        const execution =
          action === "run:execute" || action === "extension:run";
        const candidateResource = record(
          request.resource,
          action.startsWith("run:")
            ? ["kind", "tenantId", "spaceId", "threadId", "runId"]
            : ["kind", "tenantId", "spaceId", "pluginId"],
        );
        assert.equal(
          candidateResource.kind,
          action.startsWith("run:") ? "run" : "extension",
        );
        assert.equal(candidateResource.tenantId, actor.tenantId);
        assert.equal(candidateResource.spaceId, actor.spaceId);
        if (candidateResource.kind === "extension")
          assert.equal(candidateResource.pluginId, pluginId);
        else {
          extensionOpaqueId(candidateResource.threadId);
          extensionOpaqueId(candidateResource.runId);
        }
        resource = candidateResource;
        const selectedRequestKey = requestKey;
        if (selectedRequestKey === null) {
          reasonCode = "named_report_request_key_unbound";
        } else {
          runId = await savedReport(resource, execution, selectedRequestKey);
          allowed = !execution || !executionDenied;
          reasonCode = allowed
            ? "named_report_saved_paid_authority"
            : "named_report_execution_revoked";
        }
      } catch {
        allowed = false;
      }
      // Concurrent decisions cannot grow the retained audit beyond its fixed bound.
      if (decisions.length >= maximumDecisions) return false;
      decisions.push(
        Object.freeze({ action, resource, allowed, reasonCode, runId }),
      );
      return allowed;
    },
    bindRequestKey(key: string) {
      assert.equal(requestKey, null, "named_report_request_key_already_bound");
      requestKey = extensionOpaqueId(key);
    },
    denyExecution() {
      executionDenied = true;
    },
    get decisions() {
      return Object.freeze([...decisions]);
    },
  });
}

function record(
  input: unknown,
  names: readonly string[],
): Readonly<Record<string, unknown>> {
  assert.ok(
    input !== null && typeof input === "object" && !Array.isArray(input),
  );
  const prototype = Object.getPrototypeOf(input);
  assert.ok(prototype === Object.prototype || prototype === null);
  const keys = Reflect.ownKeys(input);
  assert.equal(keys.length, names.length);
  assert.ok(
    keys.every((name) => typeof name === "string" && names.includes(name)),
  );
  return Object.freeze(
    Object.fromEntries(
      names.map((name) => {
        const field = Object.getOwnPropertyDescriptor(input, name);
        assert.ok(field?.enumerable && "value" in field);
        return [name, field.value];
      }),
    ),
  );
}
