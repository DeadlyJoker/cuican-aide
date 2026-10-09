import {
  assertCreativeProjectCommitActive,
  assertCreativeProjectCommitCurrent,
} from "./creative-project-commit-authority.ts";
import type {
  CreativeProjectCommitAuthority,
  CreativeProjectCommitOptions,
} from "./creative-project-store-port.ts";

/** Reauthorize within the transaction without replacing the independently captured UI/Run grant. */
export function structuredOutlineCommitOptions(
  authority: CreativeProjectCommitAuthority | undefined,
  authorize: () => Promise<void>,
): CreativeProjectCommitOptions {
  const current = async () => {
    await authorize();
    if (authority?.outlineUiTransaction)
      await authority.outlineUiTransaction.assertCurrent();
    else if (authority?.outlineRunTransaction)
      await authority.outlineRunTransaction.assertCurrent();
    else if (authority?.planTransaction) {
      await authority.planTransaction.assertCurrent();
      await authority.planTransaction.authority.assertTransactionCurrent();
      authority.planTransaction.authority.assertActive();
    } else await assertCreativeProjectCommitCurrent(authority);
  };
  return {
    authority: Object.freeze({
      assertCurrent: current,
      assertActive: () => assertCreativeProjectCommitActive(authority),
      ...(authority?.outlineUiTransaction === undefined
        ? {}
        : {
            outlineUiTransaction: Object.freeze({
              ...authority.outlineUiTransaction,
              assertCurrent: current,
            }),
          }),
      ...(authority?.planTransaction === undefined
        ? {}
        : {
            planTransaction: Object.freeze({
              ...authority.planTransaction,
              assertCurrent: current,
            }),
          }),
      ...(authority?.outlineRunTransaction === undefined
        ? {}
        : {
            outlineRunTransaction: Object.freeze({
              ...authority.outlineRunTransaction,
              assertCurrent: current,
            }),
          }),
    }),
  };
}
