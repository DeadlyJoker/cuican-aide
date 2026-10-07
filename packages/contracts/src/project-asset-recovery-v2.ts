import {
  assetContractChecked as checked,
  assetContractCopy as copy,
  assetContractRecord as record,
  assetContractId as id,
  assetContractRevision as revision,
  assetContractDigest as digest,
  assetContractFailure as fail,
} from "./project-asset-contract-support.ts";
import {
  parseProjectAssetV2Request,
  PROJECT_ASSET_V2_ACTIONS as assetActions,
  isProjectAssetV2MutationAction,
  type ProjectAssetV2Request,
  type ProjectAssetV2MutationRequest,
} from "./project-assets-v2.ts";
export const PROJECT_ASSET_RECOVERY_V2_ACTIONS = Object.freeze({
  getPending: "crewon.project-asset-recovery.v2.getPending",
  acknowledge: "crewon.project-asset-recovery.v2.acknowledge",
  cancelPending: "crewon.project-asset-recovery.v2.cancelPending",
} as const);
export type ProjectAssetV2WriteRequest =
  | ProjectAssetV2MutationRequest
  | Extract<
      ProjectAssetV2Request,
      { action: typeof assetActions.adoptMediaReference }
    >;
export type ProjectAssetRecoveryV2Request =
  | Readonly<{
      action: typeof PROJECT_ASSET_RECOVERY_V2_ACTIONS.getPending;
      input: Readonly<Record<string, never>>;
    }>
  | Readonly<{
      action:
        | typeof PROJECT_ASSET_RECOVERY_V2_ACTIONS.acknowledge
        | typeof PROJECT_ASSET_RECOVERY_V2_ACTIONS.cancelPending;
      input: Readonly<{ intentId: string; expectedRevision: number }>;
    }>;
export type ProjectAssetV2Confirmed = Readonly<{
  assetId: string;
  assetRevision: number;
  contentRevision: number | null;
  referenceRevision: number | null;
  resultDigest: string;
}>;
export type ProjectAssetRecoveryV2Intent = Readonly<{
  intentId: string;
  revision: number;
  request: ProjectAssetV2WriteRequest;
  requestDigest: string;
}> &
  (
    | Readonly<{ phase: "pending" | "cancelled"; confirmed: null }>
    | Readonly<{ phase: "accepted"; confirmed: ProjectAssetV2Confirmed }>
  );
export type ProjectAssetRecoveryV2Response =
  | Readonly<{ intent: ProjectAssetRecoveryV2Intent | null }>
  | Readonly<{
      intentId: string;
      revision: number;
      disposition: "acknowledged" | "replayed";
    }>;
export const isProjectAssetRecoveryV2Action = (
  action: unknown,
): action is ProjectAssetRecoveryV2Request["action"] =>
  typeof action === "string" &&
  Object.values(PROJECT_ASSET_RECOVERY_V2_ACTIONS).some((a) => a === action);
export function parseProjectAssetV2WriteRequest(
  input: unknown,
): ProjectAssetV2WriteRequest {
  const r = parseProjectAssetV2Request(input);
  if (
    r.action !== assetActions.adoptMediaReference &&
    !isProjectAssetV2MutationAction(r.action)
  )
    return fail();
  return r as ProjectAssetV2WriteRequest;
}
export function parseProjectAssetRecoveryV2Request(
  input: unknown,
): ProjectAssetRecoveryV2Request {
  return checked(() => {
    const r = record(copy(input, 1024), ["action", "input"]);
    if (!isProjectAssetRecoveryV2Action(r.action)) return fail();
    if (r.action === PROJECT_ASSET_RECOVERY_V2_ACTIONS.getPending) {
      record(r.input, []);
      return Object.freeze({ action: r.action, input: Object.freeze({}) });
    }
    const q = record(r.input, ["intentId", "expectedRevision"]);
    if (
      q.expectedRevision !==
      (r.action === PROJECT_ASSET_RECOVERY_V2_ACTIONS.cancelPending ? 1 : 2)
    )
      return fail();
    return Object.freeze({
      action: r.action,
      input: Object.freeze({
        intentId: id(q.intentId),
        expectedRevision: revision(q.expectedRevision),
      }),
    });
  });
}
export function parseProjectAssetRecoveryV2Intent(
  input: unknown,
): ProjectAssetRecoveryV2Intent {
  return checked(() => {
    const r = record(copy(input, 60 * 1024), [
        "intentId",
        "revision",
        "request",
        "requestDigest",
        "phase",
        "confirmed",
      ]),
      request = parseProjectAssetV2WriteRequest(r.request);
    const common = {
      intentId: id(r.intentId),
      revision: revision(r.revision),
      request,
      requestDigest: digest(r.requestDigest),
    };
    if (r.phase === "pending" || r.phase === "cancelled") {
      if (
        r.confirmed !== null ||
        (r.phase === "pending"
          ? common.revision !== 1
          : ![2, 3].includes(common.revision))
      )
        return fail();
      return Object.freeze({ ...common, phase: r.phase, confirmed: null });
    }
    if (r.phase !== "accepted" || ![2, 3].includes(common.revision))
      return fail();
    const c = record(r.confirmed, [
        "assetId",
        "assetRevision",
        "contentRevision",
        "referenceRevision",
        "resultDigest",
      ]),
      confirmed = Object.freeze({
        assetId: id(c.assetId),
        assetRevision: revision(c.assetRevision),
        contentRevision:
          c.contentRevision === null ? null : revision(c.contentRevision),
        referenceRevision:
          c.referenceRevision === null ? null : revision(c.referenceRevision),
        resultDigest: digest(c.resultDigest),
      });
    const body =
      request.action === assetActions.adoptMediaReference
        ? request.input
        : request.input.request;
    if (
      confirmed.assetRevision !== body.expectedAssetRevision + 1 ||
      (request.input.assetId !== null &&
        confirmed.assetId !== request.input.assetId)
    )
      return fail();
    const content =
      request.action === assetActions.saveCandidate ||
      request.action === assetActions.selectRevision;
    const reference =
      request.action === assetActions.saveReferenceCandidate ||
      request.action === assetActions.selectReference ||
      request.action === assetActions.adoptMediaReference;
    if (
      (confirmed.contentRevision !== null) !== content ||
      (confirmed.referenceRevision !== null) !== reference
    )
      return fail();
    if (
      request.action === assetActions.selectRevision &&
      confirmed.contentRevision !== request.input.request.contentRevision
    )
      return fail();
    if (
      request.action === assetActions.selectReference &&
      confirmed.referenceRevision !== request.input.request.referenceRevision
    )
      return fail();
    return Object.freeze({ ...common, phase: "accepted", confirmed });
  });
}
export function parseProjectAssetRecoveryV2Response(
  request: ProjectAssetRecoveryV2Request,
  input: unknown,
): ProjectAssetRecoveryV2Response {
  return checked(() => {
    const q = parseProjectAssetRecoveryV2Request(request),
      v = copy(input, 60 * 1024);
    if (q.action === PROJECT_ASSET_RECOVERY_V2_ACTIONS.acknowledge) {
      const r = record(v, ["intentId", "revision", "disposition"]);
      if (
        r.intentId !== q.input.intentId ||
        r.revision !== q.input.expectedRevision + 1 ||
        !["acknowledged", "replayed"].includes(String(r.disposition))
      )
        return fail();
      return Object.freeze({
        intentId: id(r.intentId),
        revision: revision(r.revision),
        disposition: r.disposition as "acknowledged" | "replayed",
      });
    }
    const r = record(v, ["intent"]),
      intent =
        r.intent === null ? null : parseProjectAssetRecoveryV2Intent(r.intent);
    if (
      q.action === PROJECT_ASSET_RECOVERY_V2_ACTIONS.getPending &&
      intent?.revision === 3
    )
      return fail();
    if (
      q.action === PROJECT_ASSET_RECOVERY_V2_ACTIONS.cancelPending &&
      (!intent ||
        intent.intentId !== q.input.intentId ||
        intent.phase === "pending" ||
        intent.revision !== q.input.expectedRevision + 1)
    )
      return fail();
    return Object.freeze({ intent });
  });
}
