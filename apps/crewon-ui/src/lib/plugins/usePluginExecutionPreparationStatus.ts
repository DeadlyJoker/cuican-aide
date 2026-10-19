import { useEffect, useState } from "react";
import type { DesktopLocalPluginExecutionSetupAccess } from "../desktop/desktopLocalPluginExecutionSetupProtocol";
import { AGENT_PLATFORM_SESSION_CHANGED_EVENT } from "../agent-platform/agentPlatformClient";
import { localPluginExecutionSetupTicket } from "./localPluginExecutionSetupRecovery";
import { captureExecutionSetupStatus } from "./localPluginExecutionSetupValidation";

type PendingReceipt = Readonly<{
  client: DesktopLocalPluginExecutionSetupAccess["client"];
  ownerKey: string;
  previewId: string;
}>;

/** Read the original Main receipt across Control withdrawal. This never prepares, approves or retries. */
export function usePluginExecutionPreparationStatus(
  access: DesktopLocalPluginExecutionSetupAccess | null,
): "pending" | "none" {
  const [receipt, setReceipt] = useState<PendingReceipt | null>(null);
  const client = access?.client;
  const ownerKey = access?.ownerKey;
  useEffect(() => {
    setReceipt(null);
    if (!client || ownerKey === undefined) return;
    const current = { client, ownerKey };
    let disposed = false;
    let sequence = 0;
    const withdraw = () => {
      sequence++;
      setReceipt(null);
    };
    const read = async () => {
      const requested = ++sequence;
      const ticket = localPluginExecutionSetupTicket(current);
      if (!ticket) {
        setReceipt(null);
        return;
      }
      try {
        const raw = await client.readStatus({
          pluginId: ticket.preview.pluginId,
        });
        if (
          disposed ||
          requested !== sequence ||
          localPluginExecutionSetupTicket(current) !== ticket
        )
          return;
        const status = captureExecutionSetupStatus(
          raw,
          ticket.preview,
          ticket.preview.previewId,
        );
        setReceipt(
          status?.state === "pending"
            ? { ...current, previewId: ticket.preview.previewId }
            : null,
        );
      } catch {
        if (!disposed && requested === sequence) setReceipt(null);
      }
    };
    let releaseStatus: (() => void) | undefined;
    let releaseOwner: (() => void) | undefined;
    try {
      releaseStatus = client.subscribeStatusChanged(() => {
        void read();
      });
      releaseOwner = client.subscribeOwnerChanged(withdraw);
      if (
        typeof releaseStatus !== "function" ||
        typeof releaseOwner !== "function"
      )
        throw new Error("preparation_status_subscription_invalid");
    } catch {
      disposed = true;
      if (typeof releaseStatus === "function") releaseStatus();
      if (typeof releaseOwner === "function") releaseOwner();
      return;
    }
    window.addEventListener(AGENT_PLATFORM_SESSION_CHANGED_EVENT, withdraw);
    void read();
    return () => {
      disposed = true;
      sequence++;
      releaseStatus?.();
      releaseOwner?.();
      window.removeEventListener(
        AGENT_PLATFORM_SESSION_CHANGED_EVENT,
        withdraw,
      );
    };
  }, [client, ownerKey]);
  return access &&
    receipt !== null &&
    receipt.client === client &&
    receipt.ownerKey === ownerKey &&
    localPluginExecutionSetupTicket(access)?.preview.previewId ===
      receipt.previewId
    ? "pending"
    : "none";
}
