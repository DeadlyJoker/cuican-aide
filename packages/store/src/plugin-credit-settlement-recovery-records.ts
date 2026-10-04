import type {
  PluginCreditSettlementLocator,
  PluginCreditSettlementRecoveryPage,
  PluginCreditSettlementRecoveryScan,
} from "@crewon/application";
import { extensionOpaqueId } from "@crewon/domain";

export const RECOVERY_PAGE_LIMIT = 16;
type Row = Readonly<Record<string, unknown>>;

export function parseSettlementRecoveryScan(
  input: unknown,
): PluginCreditSettlementRecoveryScan {
  const value = fields(input, ["scope", "afterRunId", "limit"]);
  const scope = fields(value.scope, ["tenantId", "spaceId", "profileId"]);
  if (
    typeof value.limit !== "number" ||
    !Number.isSafeInteger(value.limit) ||
    value.limit < 1 ||
    value.limit > RECOVERY_PAGE_LIMIT
  )
    throw new Error("plugin_credit_settlement_recovery_scan_invalid");
  return Object.freeze({
    scope: Object.freeze({
      tenantId: identifier(scope.tenantId),
      spaceId: identifier(scope.spaceId),
      profileId: identifier(scope.profileId),
    }),
    afterRunId: value.afterRunId === null ? null : identifier(value.afterRunId),
    limit: value.limit,
  });
}

/** Every original metadata slot is returned, including held and already finalized Runs. */
export function buildSettlementRecoveryPage(
  input: PluginCreditSettlementRecoveryScan,
  rows: readonly Row[],
): PluginCreditSettlementRecoveryPage {
  const scan = parseSettlementRecoveryScan(input);
  if (!Array.isArray(rows) || rows.length > scan.limit + 1)
    throw new Error("plugin_credit_settlement_recovery_page_invalid");
  const items: PluginCreditSettlementLocator[] = [];
  let previous = scan.afterRunId;
  for (const raw of rows) {
    const row = fields(raw, ["tenant_id", "space_id", "profile_id", "run_id"]);
    const runId = identifier(row.run_id);
    if (
      row.tenant_id !== scan.scope.tenantId ||
      row.space_id !== scan.scope.spaceId ||
      row.profile_id !== scan.scope.profileId ||
      (previous !== null &&
        Buffer.compare(
          Buffer.from(previous, "utf8"),
          Buffer.from(runId, "utf8"),
        ) >= 0)
    )
      throw new Error("plugin_credit_settlement_recovery_page_invalid");
    items.push(Object.freeze({ tenantId: scan.scope.tenantId, runId }));
    previous = runId;
  }
  const checked = items.slice(0, scan.limit);
  return Object.freeze({
    items: Object.freeze(checked),
    nextRunId: items.length > scan.limit ? checked.at(-1)!.runId : null,
  });
}

function identifier(input: unknown): string {
  const value = extensionOpaqueId(input);
  for (const point of value) {
    const code = point.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff)
      throw new Error("plugin_credit_settlement_recovery_scan_invalid");
  }
  return value;
}

function fields(
  input: unknown,
  names: readonly string[],
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null) ||
    Reflect.ownKeys(input).some((key) => typeof key !== "string")
  )
    throw new Error("plugin_credit_settlement_recovery_scan_invalid");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    Object.keys(descriptors).sort().join(",") !== [...names].sort().join(",") ||
    Object.values(descriptors).some(
      (field) => !Object.hasOwn(field, "value") || !field.enumerable,
    )
  )
    throw new Error("plugin_credit_settlement_recovery_scan_invalid");
  return Object.fromEntries(
    names.map((name) => [name, descriptors[name]!.value]),
  );
}
