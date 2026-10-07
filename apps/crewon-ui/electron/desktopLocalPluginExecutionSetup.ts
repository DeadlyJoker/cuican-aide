import { composeDesktopLocalProjectAssetV2Approval } from "./desktopLocalProjectAssetV2Approval.ts";
import { composeDesktopLocalShortDramaMediaInputApproval } from "./desktopLocalShortDramaMediaInputs.ts";
import { composeDesktopLocalShortDramaMediaGenerationApproval } from "./desktopLocalShortDramaMediaGenerations.ts";
import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { performance } from "node:perf_hooks";
import {
  parseExtensionConfiguration,
  parseExtensionExecutionTarget,
} from "@crewon/domain";
import type {
  DesktopLocalPluginExecutionPreview,
  DesktopLocalPluginExecutionResult,
} from "../src/lib/desktop/desktopLocalPluginExecutionSetupProtocol.ts";
import type { DesktopPluginBootstrap } from "./desktopPluginBootstrap.ts";
import type {
  DesktopInstalledPluginExpectedCatalogEntry,
  DesktopInstalledPluginRuntime,
} from "./desktopInstalledPluginRuntime.ts";
import { composeDesktopLocalComfyProjectExecutionApproval } from "./desktopLocalComfyProjectExecutionApproval.ts";
import {
  captureDesktopLocalHistoricalProjectQueryTarget,
  isDesktopLocalHistoricalProjectQueryTargetUnavailable,
  assertDesktopLocalHistoricalProjectQueryTargetCurrent,
  assertDesktopLocalHistoricalProjectQueryTargetSynchronous,
  composeDesktopLocalHistoricalProjectQueryApproval,
  type DesktopLocalHistoricalProjectQueryTarget,
} from "./desktopLocalHistoricalProjectQueryApproval.ts";
import {
  absolutePath,
  assertApproval,
  assertParents,
  commitApproval,
  createPending,
  fields,
  readApproval,
  removePending,
} from "./desktopLocalPluginSourceImportFiles.ts";
import {
  assertSetupSnapshot,
  captureSetupSnapshot,
  mergeSetupPolicy,
  readSetupRecords,
  setupHash,
  setupInvalid,
  setupPaths,
  SHORT_NETWORK_PATHS,
  SHORT_PLUGIN_ID,
  type SetupSnapshot,
} from "./desktopLocalPluginExecutionSetupSnapshot.ts";
import type {
  RuntimeStoppedMutationOptions,
  RuntimeStoppedMutationResult,
} from "./runtimeStoppedMutation.ts";

declare const claimBrand: unique symbol;
declare const mappingBrand: unique symbol;
/** An in-process capability. Renderer data cannot reconstruct this Main-owned claim. */
export type DesktopLocalPluginExecutionSetupClaim = Readonly<{
  [claimBrand]: true;
}>;
export type DesktopLocalPluginExecutionProjectMappingClaim = Readonly<{
  [mappingBrand]: true;
}>;
type Ticket = {
  preview: DesktopLocalPluginExecutionPreview;
  deadline: number;
  snapshot: SetupSnapshot;
  bootstrapPath: string;
  policyCommitted: boolean;
  mappingCommitted: boolean;
  verified: boolean;
  entry: DesktopInstalledPluginExpectedCatalogEntry | null;
  historyQuery: DesktopLocalHistoricalProjectQueryTarget | null;
  approveMediaGenerations: boolean;
};
export type DesktopLocalPluginExecutionSetupOwner = Readonly<{
  preview(
    input: Readonly<{
      bootstrap: DesktopPluginBootstrap;
      pluginId: string;
      runtime?: DesktopInstalledPluginRuntime | null;
    }>,
  ): Promise<DesktopLocalPluginExecutionPreview>;
  claimPreview(input: unknown): DesktopLocalPluginExecutionSetupClaim;
  cancelPreview(input: Readonly<{ previewId: string }>): void;
  policyCommitted(claim: DesktopLocalPluginExecutionSetupClaim): boolean;
  commitPolicyWhileStopped(
    claim: DesktopLocalPluginExecutionSetupClaim,
  ): Promise<void>;
  captureProjectMappingWhileRunning(
    claim: DesktopLocalPluginExecutionSetupClaim,
    runtime: DesktopInstalledPluginRuntime,
  ): Promise<DesktopLocalPluginExecutionProjectMappingClaim>;
  commitProjectMappingWhileStopped(
    claim: DesktopLocalPluginExecutionProjectMappingClaim,
  ): Promise<void>;
  verifyPreparedWhileRunning(
    claim: DesktopLocalPluginExecutionSetupClaim,
    runtime: DesktopInstalledPluginRuntime,
  ): Promise<void>;
  result(
    claim: DesktopLocalPluginExecutionSetupClaim,
    input: Readonly<{
      stage: "policyCommitted" | "mappingCommitted";
      runtimeStatus: "ready" | "restartRequired";
    }>,
  ): DesktopLocalPluginExecutionResult;
  close(): Promise<void>;
}>;

export function parseDesktopLocalPluginExecutionSetupPluginId(
  input: unknown,
): string {
  const value = fields(input, ["pluginId"]);
  if (value.pluginId !== SHORT_PLUGIN_ID) setupInvalid("plugin_unsupported");
  return SHORT_PLUGIN_ID;
}

/** Main explicitly owns approval; importing/trusting a Node module never reaches this writer. */
export function createDesktopLocalPluginExecutionSetupOwner(
  input: Readonly<{
    dataDirectory: string;
    /** Document/host owner fence, deliberately independent of its own runtime restart. */
    assertCurrent(): void;
    previewLifetimeMs?: number;
  }>,
): DesktopLocalPluginExecutionSetupOwner {
  const dataDirectory = absolutePath(input.dataDirectory);
  const lifetime = input.previewLifetimeMs ?? 120_000;
  if (
    !Number.isSafeInteger(lifetime) ||
    lifetime < 1 ||
    lifetime > 300_000 ||
    typeof input.assertCurrent !== "function"
  )
    setupInvalid("owner_invalid");
  const controller = new AbortController();
  const signal = controller.signal;
  const claims = new WeakMap<DesktopLocalPluginExecutionSetupClaim, Ticket>();
  const mappings = new WeakMap<
    DesktopLocalPluginExecutionProjectMappingClaim,
    Ticket
  >();
  const pending = new Set<Promise<unknown>>();
  let preview: Ticket | null = null,
    claimed: Ticket | null = null,
    generation = 0;
  const active = () => {
    signal.throwIfAborted();
    input.assertCurrent();
  };
  const ticket = (claim: DesktopLocalPluginExecutionSetupClaim) => {
    const value = claims.get(claim);
    if (value === undefined || value !== claimed)
      setupInvalid("claim_unavailable");
    active();
    return value;
  };
  const tracked = <T>(operation: () => Promise<T>): Promise<T> => {
    active();
    if (pending.size !== 0) setupInvalid("busy");
    const promise = operation();
    pending.add(promise);
    void promise.finally(() => pending.delete(promise)).catch(() => {});
    return promise;
  };
  const assertSnapshot = (value: Ticket) =>
    assertSetupSnapshot(dataDirectory, value.snapshot, signal, active);
  const assertSynchronousPins = (value: Ticket) => {
    active();
    assertParents(value.snapshot.parents);
    const paths = setupPaths(dataDirectory);
    assertApproval(paths.approval, value.snapshot.approvalFile);
    assertApproval(paths.profile, value.snapshot.profileFile);
    assertApproval(paths.policy, value.snapshot.policyFile);
    const current = readSetupRecords(
      dataDirectory,
      value.snapshot.manifest.scope,
      value.snapshot.database,
    );
    if (
      !isDeepStrictEqual(current.selection, value.snapshot.selection) ||
      !isDeepStrictEqual(current.pkg, value.snapshot.pkg) ||
      !isDeepStrictEqual(current.configuration, value.snapshot.configuration)
    )
      setupInvalid("records_changed");
    if (value.historyQuery !== null)
      assertDesktopLocalHistoricalProjectQueryTargetSynchronous(
        value.historyQuery,
        {
          approval: value.snapshot.approval,
          policy: value.snapshot.policy,
        },
      );
  };
  const write = (
    value: Ticket,
    kind: "policy" | "approval",
    document: unknown,
    committed: () => void,
  ) => {
    const path = setupPaths(dataDirectory)[kind];
    const bytes = Buffer.from(JSON.stringify(document));
    if (bytes.length > 128 * 1024) setupInvalid("document_limit");
    const old =
      kind === "policy"
        ? value.snapshot.policyFile
        : value.snapshot.approvalFile;
    if (old?.bytes.equals(bytes)) {
      assertSynchronousPins(value);
      committed();
      return;
    }
    const staged = createPending(
      path + ".execution-pending-v1",
      bytes,
      value.snapshot.parents,
    );
    let published = false;
    try {
      // The final CAS and publication have no asynchronous gap.
      assertSynchronousPins(value);
      commitApproval({
        approvalPath: path,
        pending: staged,
        targetAbsent: old === null,
      });
      published = true;
      committed();
      const next = readApproval(path);
      if (next === null || !next.bytes.equals(bytes))
        setupInvalid("publication_changed");
      if (kind === "policy") value.snapshot.policyFile = next;
      else value.snapshot.approvalFile = next;
    } finally {
      if (!published) removePending(staged);
    }
  };
  const captureEntry = async (
    value: Ticket,
    runtime: DesktopInstalledPluginRuntime,
  ) => {
    runtime.assertCurrent();
    await assertSnapshot(value);
    active();
    runtime.assertCurrent();
    if (!isDeepStrictEqual(runtime.scope, value.snapshot.manifest.scope))
      setupInvalid("runtime_scope");
    const matches = runtime.expectedCatalogEntries.filter(
      (entry) => entry.identity.pluginId === SHORT_PLUGIN_ID,
    );
    if (matches.length !== 1) setupInvalid("runtime_unprepared");
    const raw = matches[0]!;
    const identity = fields(raw.identity, [
      "pluginId",
      "publisherId",
      "version",
      "packageDigest",
      "manifestDigest",
      "implementationDigest",
    ]);
    const expected = identityPins(value.snapshot);
    for (const key of [
      "pluginId",
      "publisherId",
      "version",
      "packageDigest",
      "manifestDigest",
      "implementationDigest",
    ] as const)
      if (identity[key] !== expected[key]) setupInvalid("runtime_identity");
    const configuration = parseExtensionConfiguration(raw.configuration, {
      sha256: setupHash,
    });
    if (!isDeepStrictEqual(configuration, value.snapshot.configuration))
      setupInvalid("runtime_configuration");
    const configuredTarget = parseExtensionExecutionTarget(
      raw.configuredTarget,
    );
    if (configuredTarget.workspaceBindingId !== null)
      setupInvalid("runtime_workspace");
    const entry = Object.freeze({
      identity: Object.freeze({ ...raw.identity }),
      configuration:
        configuration as unknown as DesktopInstalledPluginExpectedCatalogEntry["configuration"],
      configuredTarget:
        configuredTarget as unknown as DesktopInstalledPluginExpectedCatalogEntry["configuredTarget"],
    });
    runtime.assertCurrent();
    active();
    return entry;
  };
  return Object.freeze({
    preview(request) {
      if (claimed !== null) setupInvalid("busy");
      const requestFields = fields(request, [
        "bootstrap",
        "pluginId",
        ...(Object.hasOwn(request, "runtime") ? ["runtime"] : []),
      ]);
      parseDesktopLocalPluginExecutionSetupPluginId({
        pluginId: requestFields.pluginId,
      });
      const epoch = ++generation;
      return tracked(async () => {
        const snapshot = await captureSetupSnapshot({
          dataDirectory,
          bootstrap: request.bootstrap,
          signal,
          assertCurrent: active,
        });
        active();
        if (epoch !== generation) setupInvalid("preview_unavailable");
        const historyRequirement = snapshot.descriptor.requires.find(
          (requirement) =>
            requirement.service === "crewon.project-historical-queries" &&
            requirement.apiVersion === "1",
        );
        let history: Awaited<
          ReturnType<typeof captureDesktopLocalHistoricalProjectQueryTarget>
        > | null = null;
        if (historyRequirement !== undefined) {
          try {
            history = await captureDesktopLocalHistoricalProjectQueryTarget({
              dataDirectory,
              bootstrap: request.bootstrap,
              runtime: request.runtime ?? null,
              snapshot,
              signal,
              assertCurrent: active,
            });
          } catch (error) {
            if (
              !historyRequirement.optional ||
              !isDesktopLocalHistoricalProjectQueryTargetUnavailable(error)
            )
              throw error;
          }
        }
        active();
        if (epoch !== generation) setupInvalid("preview_unavailable");
        const publicPreview = Object.freeze({
          ...identityPins(snapshot),
          previewId: randomBytes(32).toString("base64url"),
          expiresAt: Date.now() + lifetime,
          baseUrl: snapshot.baseUrl,
          preset: snapshot.preset,
          networkPaths:
            snapshot.policy?.networkGrants.find(
              (grant) =>
                grant.packageDigest === snapshot.pkg.packageDigest &&
                grant.baseUrlParameter === "baseUrl",
            )?.paths ?? SHORT_NETWORK_PATHS,
          approvalRequirement: "none" as const,
          ...(snapshot.mediaInputs === null
            ? {}
            : {
                mediaInputPreparation: Object.freeze({
                  scope: "read-write-inputs" as const,
                  workflows: Object.freeze(
                    snapshot.mediaInputs.reviews.map((r) =>
                      Object.freeze({
                        workflowId: r.workflow.workflowId,
                        workflowDigest: r.workflow.workflowDigest,
                      }),
                    ),
                  ),
                }),
              }),
          ...(historyRequirement === undefined
            ? {}
            : {
                historyQueryAvailability:
                  history === null
                    ? ("unavailable" as const)
                    : ("available" as const),
              }),
          ...(history === null ? {} : { historyQuery: history.preview }),
          ...(snapshot.mediaGenerations === null
            ? {}
            : { mediaGenerationPreparation: snapshot.mediaGenerations }),
        });
        preview = {
          preview: publicPreview,
          deadline: performance.now() + lifetime,
          snapshot,
          bootstrapPath: request.bootstrap.bootstrapPath,
          policyCommitted: false,
          mappingCommitted: false,
          verified: false,
          entry: null,
          historyQuery: history?.claim ?? null,
          approveMediaGenerations: false,
        };
        return publicPreview;
      });
    },
    claimPreview(request) {
      active();
      const withHistory = preview !== null && preview.historyQuery !== null;
      const withMediaGenerations =
        request !== null &&
        typeof request === "object" &&
        Object.hasOwn(request, "approveMediaGenerations");
      const value = fields(request, [
        "previewId",
        "approveExecution",
        ...(withHistory ? ["approveHistoricalQueries"] : []),
        ...(withMediaGenerations ? ["approveMediaGenerations"] : []),
      ]);
      if (
        value.approveExecution !== true ||
        typeof value.previewId !== "string" ||
        (withHistory && value.approveHistoricalQueries !== true) ||
        (withMediaGenerations &&
          (value.approveMediaGenerations !== true ||
            preview?.snapshot.mediaGenerations == null))
      )
        setupInvalid("consent_required");
      if (
        pending.size !== 0 ||
        claimed !== null ||
        preview === null ||
        value.previewId !== preview.preview.previewId
      )
        setupInvalid("preview_unavailable");
      if (
        performance.now() >= preview.deadline ||
        Date.now() >= preview.preview.expiresAt
      )
        setupInvalid("preview_expired");
      const claim = Object.freeze({}) as DesktopLocalPluginExecutionSetupClaim;
      claimed = preview;
      claimed.approveMediaGenerations = withMediaGenerations;
      preview = null;
      claims.set(claim, claimed);
      ticket(claim);
      return claim;
    },
    cancelPreview(request) {
      active();
      const value = fields(request, ["previewId"]);
      if (typeof value.previewId !== "string") setupInvalid("preview_invalid");
      if (preview?.preview.previewId === value.previewId) {
        preview = null;
        generation++;
      }
    },
    policyCommitted(claim) {
      // Receipt facts remain readable after withdrawal; no authority is returned.
      const value = claims.get(claim);
      if (value === undefined) setupInvalid("claim_unavailable");
      return value.policyCommitted;
    },
    commitPolicyWhileStopped(claim) {
      return tracked(async () => {
        const value = ticket(claim);
        if (value.policyCommitted) setupInvalid("policy_already_committed");
        await assertSnapshot(value);
        ticket(claim);
        const next = mergeSetupPolicy(
          dataDirectory,
          value.snapshot,
          value.bootstrapPath,
          value.approveMediaGenerations ? "enable" : "preserve",
        );
        write(value, "policy", next, () => {
          value.policyCommitted = true;
          value.snapshot.policy = next;
        });
      });
    },
    captureProjectMappingWhileRunning(claim, runtime) {
      return tracked(async () => {
        const value = ticket(claim);
        if (
          !value.policyCommitted ||
          value.mappingCommitted ||
          value.entry !== null
        )
          setupInvalid("mapping_unavailable");
        value.entry = await captureEntry(value, runtime);
        if (value.historyQuery !== null)
          await assertDesktopLocalHistoricalProjectQueryTargetCurrent(
            value.historyQuery,
            {
              approval: value.snapshot.approval,
              policy: value.snapshot.policy,
              runtime,
            },
          );
        ticket(claim);
        const mapping = Object.freeze(
          {},
        ) as DesktopLocalPluginExecutionProjectMappingClaim;
        mappings.set(mapping, value);
        return mapping;
      });
    },
    commitProjectMappingWhileStopped(mapping) {
      return tracked(async () => {
        const value = mappings.get(mapping);
        if (
          value === undefined ||
          value !== claimed ||
          value.entry === null ||
          value.mappingCommitted
        )
          setupInvalid("mapping_unavailable");
        active();
        await assertSnapshot(value);
        active();
        const source = {
          descriptor: value.snapshot.descriptor,
          packageDigest: value.snapshot.pkg.packageDigest,
          contributionId: "workbench",
        };
        const generationApproval =
          composeDesktopLocalComfyProjectExecutionApproval({
            approval: value.snapshot.approval,
            source,
            target: {
              descriptor: value.snapshot.descriptor,
              contributionId: "workbench",
              entry: value.entry,
            },
          });
        const inputApproval = composeDesktopLocalShortDramaMediaInputApproval({
          approval: generationApproval,
          descriptor: source.descriptor,
          packageDigest: source.packageDigest,
          declaration: value.snapshot.mediaInputs,
        });
        const mediaApproval = value.approveMediaGenerations
          ? composeDesktopLocalShortDramaMediaGenerationApproval({
              approval: inputApproval,
              packageDigest: source.packageDigest,
            })
          : inputApproval;
        const selfApproval = composeDesktopLocalProjectAssetV2Approval({
          approval: mediaApproval,
          descriptor: source.descriptor,
          packageDigest: source.packageDigest,
        });
        if (value.historyQuery !== null)
          await assertDesktopLocalHistoricalProjectQueryTargetCurrent(
            value.historyQuery,
            {
              approval: value.snapshot.approval,
              policy: value.snapshot.policy,
            },
          );
        const next =
          value.historyQuery === null
            ? selfApproval
            : composeDesktopLocalHistoricalProjectQueryApproval({
                claim: value.historyQuery,
                approval: selfApproval,
                policy: value.snapshot.policy,
              });
        // The saved entry is an opaque Main claim captured before stop. Its old runtime is now withdrawn.
        write(value, "approval", next, () => {
          value.mappingCommitted = true;
          value.snapshot.approval = next;
        });
      });
    },
    verifyPreparedWhileRunning(claim, runtime) {
      return tracked(async () => {
        const value = ticket(claim);
        if (!value.mappingCommitted || value.entry === null)
          setupInvalid("mapping_unavailable");
        const current = await captureEntry(value, runtime);
        ticket(claim);
        if (!isDeepStrictEqual(current, value.entry))
          setupInvalid("runtime_changed");
        if (value.historyQuery !== null)
          await assertDesktopLocalHistoricalProjectQueryTargetCurrent(
            value.historyQuery,
            {
              approval: value.snapshot.approval,
              policy: value.snapshot.policy,
              runtime,
            },
          );
        value.verified = true;
      });
    },
    result(claim, result) {
      const value = claims.get(claim);
      if (
        value === undefined ||
        !value.policyCommitted ||
        (result.stage === "mappingCommitted" && !value.mappingCommitted)
      )
        setupInvalid("result_uncommitted");
      const prepared =
        result.stage === "mappingCommitted" && result.runtimeStatus === "ready";
      if (prepared) {
        active();
        if (!value.verified) setupInvalid("runtime_unverified");
      }
      return Object.freeze({
        ...identityPins(value.snapshot),
        state: prepared ? "prepared" : "restartRequired",
        runtimeStatus: prepared ? "ready" : "restartRequired",
        stage: result.stage,
      });
    },
    async close() {
      controller.abort(
        new Error("desktop_plugin_execution_setup_owner_withdrawn"),
      );
      generation++;
      preview = null;
      await Promise.allSettled([...pending]);
    },
  } satisfies DesktopLocalPluginExecutionSetupOwner);
}

export async function runDesktopLocalPluginExecutionSetup(
  input: Readonly<{
    owner: DesktopLocalPluginExecutionSetupOwner;
    claim: DesktopLocalPluginExecutionSetupClaim;
    onStopInvalidation(stop: () => Promise<void>): Promise<void>;
  }>,
  port: Readonly<{
    mutateWhileStopped<T>(
      options: RuntimeStoppedMutationOptions<T>,
    ): Promise<RuntimeStoppedMutationResult<T>>;
    preparedRuntime(): DesktopInstalledPluginRuntime | null;
  }>,
): Promise<DesktopLocalPluginExecutionResult> {
  const { owner, claim, onStopInvalidation } = input;
  const policy = await port.mutateWhileStopped({
    mutation: () => owner.commitPolicyWhileStopped(claim),
    onStopInvalidation,
  });
  if (policy.runtimeStatus !== "ready")
    return owner.result(claim, {
      stage: "policyCommitted",
      runtimeStatus: "restartRequired",
    });
  const runtime = port.preparedRuntime();
  if (runtime === null) setupInvalid("runtime_unprepared");
  const mapping = await owner.captureProjectMappingWhileRunning(claim, runtime);
  const publication = await port.mutateWhileStopped({
    mutation: () => owner.commitProjectMappingWhileStopped(mapping),
    onStopInvalidation,
  });
  if (publication.runtimeStatus === "ready") {
    const current = port.preparedRuntime();
    if (current === null) setupInvalid("runtime_unprepared");
    await owner.verifyPreparedWhileRunning(claim, current);
  }
  return owner.result(claim, {
    stage: "mappingCommitted",
    runtimeStatus: publication.runtimeStatus,
  });
}
function identityPins(snapshot: SetupSnapshot) {
  return {
    pluginId: snapshot.pkg.pluginId,
    publisherId: snapshot.pkg.publisherId,
    version: snapshot.pkg.version,
    packageDigest: snapshot.pkg.packageDigest,
    manifestDigest: snapshot.configuration.manifestDigest,
    implementationDigest: snapshot.configuration.implementationDigest,
    selectionRevision: snapshot.selection.revision,
    configurationRevision: snapshot.configuration.revision,
    configurationDigest: snapshot.configuration.contentDigest,
  };
}
