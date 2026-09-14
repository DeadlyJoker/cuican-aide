import { useCallback, useEffect, useRef, useState } from "react";
import { getDesktopBridge } from "../../lib/desktop/desktopBridge";
import type {
  RecordingSkillImportListener,
  RecordingSkillImportResult,
} from "../../lib/desktop/recordingBridge";

export type SkillLibraryOpenRequest = { requestId: string; skillId: string };
type ImportBridge = {
  onSkillImportRequest(listener: RecordingSkillImportListener): () => void;
};
type ImportControlClient = {
  requestSkill(path: string, init?: RequestInit): Promise<Response>;
};
type ImportAttempt = {
  requestId: string;
  requestIds: Set<string>;
  body: string;
  result: RecordingSkillImportResult | null;
  pending: Promise<RecordingSkillImportResult> | null;
  controller: AbortController | null;
};

const cancelled = (): RecordingSkillImportResult => ({
  ok: false,
  message:
    "主窗口连接已变化，导入结果尚未确认；重新连接后请先检查 Skill 资源库。",
});
function failureMessage(status: number): string {
  if (status === 401) return "登录状态已失效，请重新登录后在录制窗口重试导入。";
  if (status === 403)
    return "当前账号没有导入 Skill 的权限，请检查工作区权限后重试。";
  if (status === 409)
    return "录制版本或导入请求发生冲突，请核对录制内容和 Skill 资源库。";
  if (status === 413)
    return "录制与证据超过导入大小限制，请减少录制内容后再试。";
  if (status === 400 || status === 422)
    return "录制或证据未通过校验，请检查录制内容后再试。";
  return "导入结果尚未确认，请在录制窗口重试；相同内容会沿用原导入请求。";
}

/** Receives only the typed desktop handoff; authentication remains in Control. */
export function useRecordingSkillImport({
  controlClient,
  bridge = getDesktopBridge()?.recording ?? null,
  onImported,
  onFailure,
}: {
  controlClient: ImportControlClient | null;
  bridge?: ImportBridge | null;
  onImported?: (skillId: string) => void;
  onFailure?: (message: string) => void;
}) {
  const [openRequest, setOpenRequest] =
    useState<SkillLibraryOpenRequest | null>(null);
  const callbacks = useRef({ onImported, onFailure });
  callbacks.current = { onImported, onFailure };

  useEffect(() => {
    setOpenRequest(null);
    if (!controlClient || !bridge) return;
    let active = true;
    // Bounded memory within one authenticated registration. Evidence never
    // goes to browser storage; uncertain commands keep their original key.
    const attempts: ImportAttempt[] = [];
    const unsubscribe = bridge.onSkillImportRequest(async (request) => {
      if (!active) return cancelled();
      const body = JSON.stringify({
        recording: request.recording,
        evidence: request.evidence,
      });
      let attempt = attempts.find((entry) =>
        entry.requestIds.has(request.requestId),
      );
      if (attempt && attempt.body !== body) {
        const result = {
          ok: false,
          message: "同一导入请求的内容变化，已停止提交；请核对原录制后重试。",
        };
        callbacks.current.onFailure?.(result.message);
        return result;
      }
      // The native recorder assigns a new handoff id on each click. A repeat
      // of the exact payload must recover the original server command.
      attempt ??= attempts.find((entry) => entry.body === body);
      if (!attempt) {
        if (attempts.length >= 8) {
          const completed = attempts.findIndex((entry) => entry.result?.ok);
          if (completed < 0) {
            const result = {
              ok: false,
              message:
                "有多条导入结果尚未确认，请先重试已有录制并检查 Skill 资源库。",
            };
            callbacks.current.onFailure?.(result.message);
            return result;
          }
          attempts.splice(completed, 1);
        }
        attempt = {
          requestId: request.requestId,
          requestIds: new Set([request.requestId]),
          body,
          result: null,
          pending: null,
          controller: null,
        };
        attempts.push(attempt);
      }
      attempt.requestIds.add(request.requestId);
      const command = attempt;
      if (!command.result?.ok && !command.pending) {
        command.controller = new AbortController();
        command.pending = (async (): Promise<RecordingSkillImportResult> => {
          try {
            const response = await controlClient.requestSkill(
              "/api/v1/skills",
              {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  "idempotency-key": command.requestId,
                },
                body: command.body,
                signal: command.controller!.signal,
              },
            );
            if (!response.ok)
              return { ok: false, message: failureMessage(response.status) };
            const value: unknown = await response.json();
            if (
              !value ||
              typeof value !== "object" ||
              !("skillId" in value) ||
              typeof value.skillId !== "string" ||
              !value.skillId.trim()
            ) {
              return { ok: false, message: failureMessage(502) };
            }
            return {
              ok: true,
              message: "录制已导入为待审阅草稿，请在主窗口继续整理方法。",
              skillId: value.skillId,
            };
          } catch {
            return active
              ? { ok: false, message: failureMessage(0) }
              : cancelled();
          }
        })();
      }
      const result = command.result?.ok
        ? command.result
        : await command.pending!;
      command.result = result;
      command.pending = null;
      if (!active) return cancelled();
      if (result.ok && result.skillId) {
        setOpenRequest({
          requestId: request.requestId,
          skillId: result.skillId,
        });
        callbacks.current.onImported?.(result.skillId);
      } else callbacks.current.onFailure?.(result.message);
      return result;
    });
    return () => {
      active = false;
      unsubscribe();
      for (const attempt of attempts) attempt.controller?.abort();
    };
  }, [bridge, controlClient]);

  const acknowledgeOpen = useCallback((requestId: string) => {
    setOpenRequest((current) =>
      current?.requestId === requestId ? null : current,
    );
  }, []);
  return { openRequest, acknowledgeOpen };
}
