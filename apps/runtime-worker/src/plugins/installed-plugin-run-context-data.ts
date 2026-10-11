/** Compatibility re-export of the original shared receipt/Run validator. No authority is issued here. */
export {
  assertPluginTaskRunReceipt as validateReceipt,
  assertPluginTaskRunSnapshot as assertRun,
} from "@crewon/application";
