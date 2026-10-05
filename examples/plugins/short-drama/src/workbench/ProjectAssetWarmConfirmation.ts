import type {
  PluginProjectAssetUiClient,
  ProjectAssetMutationResponse,
  PublicProjectAsset,
  PublicProjectAssetReferenceRevision,
  PublicProjectAssetRevision,
  PublicProjectAssetView,
} from "../project-assets-service";
import type { ProjectAssetRecoveryIntent } from "../project-asset-recovery-service";
import type {
  AssetIntent,
  AssetSnapshot,
} from "./ProjectAssetController.types";
import type { ProjectAssetRecoveryController } from "./ProjectAssetRecoveryController";
import { dispatchAssetMutation } from "./ProjectAssetMutationDispatch";
import { assetDraftFromRevision } from "./ProjectAssetDraftSources";

export type AssetWarmReceipt = Readonly<{
  intent: AssetIntent;
  result: ProjectAssetMutationResponse;
}>;
export type AssetWarmReview = Readonly<{
  view: PublicProjectAssetView;
  content: PublicProjectAssetRevision;
  reference: PublicProjectAssetReferenceRevision | null;
  record: Extract<ProjectAssetRecoveryIntent, { phase: "accepted" }>;
}>;

/** Compare public JSON records without relying on object property order. */
function same(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  )
    return false;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, i) => same(item, right[i]))
    );
  const a = Object.keys(left),
    b = Object.keys(right);
  return (
    a.length === b.length &&
    a.every(
      (key) =>
        Object.hasOwn(right, key) &&
        same(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key],
        ),
    )
  );
}
function invalid(): never {
  throw new Error("project_asset_warm_confirmation_invalid");
}

/** This is local receipt correlation, never a host grant or a replacement for the strict client codec. */
export function assertAssetWarmRecord(
  receipt: AssetWarmReceipt,
  record: ProjectAssetRecoveryIntent | null,
): asserts record is Extract<
  ProjectAssetRecoveryIntent,
  { phase: "accepted" }
> {
  const { intent, result } = receipt;
  const kinds = {
    "crewon.project-assets.v1.saveCandidate": "save-content",
    "crewon.project-assets.v1.selectRevision": "select-content",
    "crewon.project-assets.v1.setLocked": "set-lock",
    "crewon.project-assets.v1.saveReferenceCandidate": "save-reference",
    "crewon.project-assets.v1.selectReference": "select-reference",
  } as const;
  if (
    !record ||
    record.phase !== "accepted" ||
    !same(record.request, intent) ||
    result.kind !== kinds[intent.action] ||
    result.asset.projectId !== intent.input.projectId ||
    (intent.input.assetId !== null &&
      result.asset.assetId !== intent.input.assetId) ||
    result.asset.revision !== intent.input.request.expectedAssetRevision + 1 ||
    record.confirmed.kind !== result.kind ||
    record.confirmed.assetId !== result.asset.assetId ||
    record.confirmed.assetRevision !== result.asset.revision ||
    record.confirmed.contentRevision !==
      (result.contentRevision?.contentRevision ?? null) ||
    record.confirmed.referenceRevision !==
      (result.referenceRevision?.referenceRevision ?? null) ||
    record.confirmed.requestDigest !== record.requestDigest
  )
    invalid();
  switch (intent.action) {
    case "crewon.project-assets.v1.saveCandidate": {
      const content = result.contentRevision,
        original = intent.input.request;
      if (
        !content ||
        content.kind !== original.kind ||
        !same(content.content, original.content) ||
        content.brief.briefRevision !== original.briefRevision ||
        (original.script === null
          ? content.script !== null
          : content.script?.artifactId !== original.script.artifactId ||
            content.script?.contentRevision !== original.script.contentRevision)
      )
        invalid();
      break;
    }
    case "crewon.project-assets.v1.selectRevision":
      if (
        result.contentRevision?.contentRevision !==
          intent.input.request.contentRevision ||
        result.asset.selectedContentRevision !==
          intent.input.request.contentRevision
      )
        invalid();
      break;
    case "crewon.project-assets.v1.setLocked":
      if (result.asset.locked !== intent.input.request.locked) invalid();
      break;
    case "crewon.project-assets.v1.saveReferenceCandidate": {
      const reference = result.referenceRevision,
        original = intent.input.request;
      if (
        !reference ||
        reference.assetContentRevision !== original.assetContentRevision ||
        reference.source.conceptAssetId !== original.conceptAssetId ||
        reference.source.selectionRevision !== original.selectionRevision
      )
        invalid();
      break;
    }
    case "crewon.project-assets.v1.selectReference":
      if (
        result.referenceRevision?.referenceRevision !==
          intent.input.request.referenceRevision ||
        result.asset.selectedReferenceRevision !==
          intent.input.request.referenceRevision
      )
        invalid();
  }
}

/** Only the caller's current, successful write can reach ACK. Cold reads never call this helper. */
export async function confirmWarmAssetWrite(
  input: Readonly<{
    receipt: AssetWarmReceipt;
    client: PluginProjectAssetUiClient;
    recovery: ProjectAssetRecoveryController;
    signal: AbortSignal;
    isCurrent(): boolean;
    acknowledged(): void;
    present(review: AssetWarmReview): void;
  }>,
): Promise<void> {
  const current = () => {
    input.signal.throwIfAborted();
    if (!input.isCurrent()) invalid();
  };
  current();
  const record = await input.recovery.check();
  current();
  if (input.recovery.getSnapshot().phase !== "ready") invalid();
  assertAssetWarmRecord(input.receipt, record);
  const { result } = input.receipt,
    projectId = result.asset.projectId,
    assetId = result.asset.assetId,
    options = { signal: input.signal };
  let reference: PublicProjectAssetReferenceRevision | null = null;
  const referenceRevision =
    result.referenceRevision?.referenceRevision ??
    (result.kind === "set-lock"
      ? result.asset.selectedReferenceRevision
      : null);
  if (referenceRevision !== null) {
    const response = await input.client.getReferenceRevision(
      { projectId, assetId, referenceRevision },
      options,
    );
    current();
    reference = response.referenceRevision;
    if (
      reference.projectId !== projectId ||
      reference.assetId !== assetId ||
      reference.referenceRevision !== referenceRevision ||
      (result.referenceRevision !== null &&
        !same(reference, result.referenceRevision))
    )
      invalid();
  }
  const contentRevision =
    result.contentRevision?.contentRevision ??
    reference?.assetContentRevision ??
    result.asset.selectedContentRevision ??
    result.asset.latestContentRevision;
  const response = await input.client.getRevision(
    { projectId, assetId, contentRevision },
    options,
  );
  current();
  const content = response.contentRevision;
  if (
    content.projectId !== projectId ||
    content.assetId !== assetId ||
    content.kind !== result.asset.kind ||
    content.contentRevision !== contentRevision ||
    (result.contentRevision !== null &&
      !same(content, result.contentRevision)) ||
    (reference !== null &&
      reference.assetContentDigest !== content.contentDigest)
  )
    invalid();
  const { view } = await input.client.getAsset({ projectId, assetId }, options);
  current();
  if (
    !view ||
    view.asset.projectId !== projectId ||
    view.asset.assetId !== assetId ||
    view.asset.revision < result.asset.revision
  )
    invalid();
  input.present({ view, content, reference, record });
  current();
  const cleared = await input.recovery.acknowledge(record, {
    isCurrent: input.isCurrent,
    signal: input.signal,
    onAcknowledged: input.acknowledged,
  });
  current();
  if (!cleared) invalid();
}

/** A delayed receipt or read can never replace a newer observed head. */
export function mergeAssetHeads(
  current: readonly PublicProjectAsset[],
  incoming: readonly PublicProjectAsset[],
): readonly PublicProjectAsset[] {
  const heads = new Map(current.map((asset) => [asset.assetId, asset]));
  for (const asset of incoming) {
    const previous = heads.get(asset.assetId);
    if (!previous || previous.revision <= asset.revision)
      heads.set(asset.assetId, asset);
  }
  return [...heads.values()];
}

export function assetViewWithoutRegression(
  current: PublicProjectAssetView | null,
  heads: readonly PublicProjectAsset[],
  incoming: PublicProjectAssetView,
): PublicProjectAssetView {
  const previous = heads.find(
    (head) => head.assetId === incoming.asset.assetId,
  );
  if (previous && previous.revision > incoming.asset.revision) {
    if (
      !current ||
      current.asset.assetId !== previous.assetId ||
      current.asset.revision < previous.revision
    )
      invalid();
    return current;
  }
  return current?.asset.assetId === incoming.asset.assetId &&
    current.asset.revision > incoming.asset.revision
    ? current
    : incoming;
}

/** Keep a confirmed write separate from any later read/ACK failure. */
export async function executeWarmAssetMutation(
  input: Readonly<{
    intent: AssetIntent;
    client: PluginProjectAssetUiClient;
    recovery: ProjectAssetRecoveryController;
    signal: AbortSignal;
    isCurrent(): boolean;
    snapshot(): AssetSnapshot;
    publish(patch: Partial<AssetSnapshot>): void;
    confirmed(receipt: AssetWarmReceipt): void;
    acknowledged(receipt: AssetWarmReceipt): void;
  }>,
): Promise<void> {
  let result: ProjectAssetMutationResponse;
  try {
    result = await dispatchAssetMutation(
      input.client,
      input.intent,
      input.signal,
    );
  } catch {
    if (input.isCurrent()) {
      input.publish({
        error: "尚未确认保存结果。重试会使用同一项目、版本和原请求。",
      });
      await input.recovery.check();
    }
    return;
  }
  if (!input.isCurrent()) return;
  const receipt = structuredClone({ intent: input.intent, result });
  input.confirmed(receipt);
  input.publish({
    pending: null,
    assets: mergeAssetHeads(input.snapshot().assets, [result.asset]),
    notice: "资产版本已保存。",
    ...(input.intent.action === "crewon.project-assets.v1.saveCandidate" &&
    result.contentRevision
      ? {
          content: result.contentRevision,
          draft: assetDraftFromRevision(result.contentRevision),
          dirty: false,
        }
      : {}),
  });
  try {
    await confirmWarmAssetWrite({
      receipt,
      client: input.client,
      recovery: input.recovery,
      signal: input.signal,
      isCurrent: input.isCurrent,
      acknowledged: () => input.acknowledged(receipt),
      present: ({ view, content, reference, record }) => {
        if (!input.isCurrent()) return;
        const current = input.snapshot();
        input.publish({
          view: assetViewWithoutRegression(current.view, current.assets, view),
          assets: mergeAssetHeads(current.assets, [view.asset]),
          presentedRecovery: `${record.intentId}:${record.revision}`,
          ...(result.contentRevision
            ? { content, draft: assetDraftFromRevision(content), dirty: false }
            : {}),
          ...(reference ? { references: [reference] } : {}),
        });
      },
    });
  } catch {
    if (input.isCurrent())
      input.publish({
        error: "保存已确认，核对结果暂未完成。请重新读取原记录，尚未再次保存。",
      });
  }
}
