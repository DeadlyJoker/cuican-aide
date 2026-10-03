import { parsePluginUiLease } from "@crewon/contracts/plugins";
import {
  readInstalledPluginTaskReceipt,
  type InstalledPluginTaskReceiptEvent,
} from "./installedPluginTaskReceipt";
import { PluginUiLoaderError } from "./pluginUiValidation";
import type { InstalledPluginTaskReceiptSource } from "./useInstalledPluginTaskContext.types";

const MAX_RECEIPTS = 32;
const MAX_PLUGIN_RECEIPTS = 8;

/** A bounded, account-owned recovery hint. Every reader still verifies the real Control task. */
export function createInstalledPluginTaskReceipts({
  assertCurrent,
  onDiagnostic,
}: Readonly<{
  assertCurrent(): void;
  onDiagnostic(error: unknown): void;
}>): InstalledPluginTaskReceiptSource &
  Readonly<{
    observe(event: InstalledPluginTaskReceiptEvent): void;
    invalidate(): void;
  }> {
  let stopped = false;
  let receipts: readonly InstalledPluginTaskReceiptEvent[] = Object.freeze([]);
  const listeners = new Set<(event: InstalledPluginTaskReceiptEvent) => void>();
  return Object.freeze({
    snapshot: () => receipts,
    subscribe(listener: (event: InstalledPluginTaskReceiptEvent) => void) {
      if (stopped) return () => undefined;
      assertCurrent();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    observe(event: InstalledPluginTaskReceiptEvent) {
      if (stopped) return;
      assertCurrent();
      const receipt = readInstalledPluginTaskReceipt(event.receipt);
      if (!receipt)
        throw new PluginUiLoaderError("plugin_ui_task_receipt_invalid");
      const owned = Object.freeze({
        lease: parsePluginUiLease(event.lease),
        receipt,
      });
      const pluginId = owned.lease.descriptor.pluginId;
      // A replay is the same committed task, even if its disposition changes.
      const next = [
        owned,
        ...receipts.filter(
          (previous) =>
            previous.lease.descriptor.pluginId !== pluginId ||
            previous.receipt.runId !== owned.receipt.runId,
        ),
      ];
      let pluginCount = 0;
      receipts = Object.freeze(
        next
          .filter(
            (previous) =>
              previous.lease.descriptor.pluginId !== pluginId ||
              ++pluginCount <= MAX_PLUGIN_RECEIPTS,
          )
          .slice(0, MAX_RECEIPTS),
      );
      for (const listener of [...listeners]) {
        if (stopped) break;
        try {
          assertCurrent();
          listener(owned);
        } catch (error) {
          try {
            onDiagnostic(error);
          } catch {
            // Diagnostics never restore an account or erase a committed receipt.
          }
        }
      }
    },
    invalidate() {
      stopped = true;
      receipts = Object.freeze([]);
      listeners.clear();
    },
  });
}
