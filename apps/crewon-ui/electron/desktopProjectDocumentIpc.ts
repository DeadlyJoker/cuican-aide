import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import type { RuntimeSupervisor } from "./runtimeSupervisor.ts";
import type { DesktopProjectDocumentTarget } from "../src/lib/desktop/desktopProjectDocuments.ts";

/** Bound only through Main's authenticated first-party renderer guard. */
export function bindDesktopProjectDocumentIpc(input: {
  register(channel: string, handler: (request: unknown) => unknown): void;
  window: BrowserWindow;
  runtime: RuntimeSupervisor;
}) {
  const subscriptions = new Map<string, () => void>();
  let pending = 0;
  let epoch = 0;
  input.register("crewon:project-document:read", async (value) => {
    const target = parseTarget(value);
    const access = await input.runtime.projectDocumentAccess(target, "read");
    return access.read(target.documentId);
  });
  input.register("crewon:project-document:save", async (value) => {
    const target = parseTarget(value, ["content", "expectedRevision"]);
    const request = value as DesktopProjectDocumentTarget & {
      content: string;
      expectedRevision: number;
    };
    const access = await input.runtime.projectDocumentAccess(target, "write");
    return access.save({
      documentId: target.documentId,
      content: request.content,
      expectedRevision: request.expectedRevision,
    });
  });
  input.register("crewon:project-document:subscribe", async (value) => {
    if (subscriptions.size + pending >= 16)
      throw new Error("project_document_subscription_capacity");
    const capturedEpoch = epoch;
    const target = parseTarget(value);
    pending++;
    try {
      const access = await input.runtime.projectDocumentAccess(target, "read");
      const id = randomUUID();
      const stop = await access.subscribe(target.documentId, () => {
        if (
          !input.window.isDestroyed() &&
          !input.window.webContents.isDestroyed()
        )
          input.window.webContents.send("crewon:project-document:changed", id);
      });
      if (input.window.isDestroyed() || epoch !== capturedEpoch) {
        stop();
        throw new Error("project_document_session_changed");
      }
      subscriptions.set(id, stop);
      return id;
    } finally {
      pending--;
    }
  });
  input.register("crewon:project-document:unsubscribe", (id) => {
    if (typeof id !== "string") return;
    subscriptions.get(id)?.();
    subscriptions.delete(id);
  });
  const clear = () => {
    epoch++;
    for (const stop of subscriptions.values()) stop();
    subscriptions.clear();
  };
  const detach = input.runtime.onSessionInvalidated(clear);
  input.window.once("closed", () => {
    clear();
    detach();
  });
}

function parseTarget(
  value: unknown,
  extra: readonly string[] = [],
): DesktopProjectDocumentTarget {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("project_document_target_invalid");
  const fields = value as Record<string, unknown>;
  const keys = [
    "threadId",
    "projectId",
    "packageIdentity",
    "documentId",
    ...extra,
  ];
  if (
    Object.keys(fields).length !== keys.length ||
    Object.keys(fields).some((key) => !keys.includes(key)) ||
    ![fields.threadId, fields.projectId].every(
      (id) =>
        typeof id === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id),
    ) ||
    typeof fields.documentId !== "string" ||
    !/^[a-z][a-z0-9_-]{0,79}$/.test(fields.documentId)
  )
    throw new Error("project_document_target_invalid");
  return fields as DesktopProjectDocumentTarget;
}
