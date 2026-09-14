import { useLayoutEffect, useRef, useState } from "react";
import type { SkillInvocationSpec } from "@crewon/domain/demonstrated-skill";
import {
  skillAutomationDraft,
  type AutomationCreateDraft,
} from "../app/automationCreateDraft";
import type { SkillLibraryControlClient } from "./SkillLibraryHost";

type Input = { title: string; invocation: SkillInvocationSpec };
export function useSkillScheduleEntry({
  controlClient,
  selectedThreadId,
  onReady,
}: {
  controlClient: SkillLibraryControlClient | null;
  selectedThreadId: string | null;
  onReady: (draft: AutomationCreateDraft, threadId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<{
    input: Input;
    key: string;
    requestId: number;
    threadId: string | null;
  } | null>(null);
  const active = useRef(true);
  const working = useRef(false);
  const authority = useRef(controlClient);
  const epoch = useRef(0);
  useLayoutEffect(() => {
    epoch.current += 1;
    active.current = true;
    if (authority.current !== controlClient) {
      authority.current = controlClient;
      pending.current = null;
      working.current = false;
      setBusy(false);
      setError(null);
    }
    return () => {
      active.current = false;
      epoch.current += 1;
    };
  }, [controlClient]);
  async function request(input: Input) {
    if (working.current) return;
    if (!controlClient) {
      setError("当前无法准备日程，请检查连接后重试。");
      return;
    }
    if (
      pending.current &&
      JSON.stringify(pending.current.input) !== JSON.stringify(input)
    ) {
      setError("上次日程准备尚未确认，请先重试原请求。");
      return;
    }
    const attempt = pending.current ?? {
      input: structuredClone(input),
      key: `skill-schedule:${crypto.randomUUID()}`,
      requestId: Date.now(),
      threadId: input.invocation.deliveryTarget?.threadId ?? selectedThreadId,
    };
    pending.current = attempt;
    const currentEpoch = epoch.current;
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      if (!attempt.threadId) {
        const result = await controlClient.createThread(
          { title: `Skill 日程 · ${attempt.input.title}` },
          attempt.key,
        );
        if (!active.current || currentEpoch !== epoch.current) return;
        attempt.threadId = result.thread.threadId;
      }
      const { thread } = await controlClient.getThread(attempt.threadId);
      if (
        thread.threadId !== attempt.threadId ||
        !thread.threadId ||
        thread.status !== "active" ||
        !Number.isSafeInteger(thread.revision) ||
        thread.revision < 0
      )
        throw new Error("skill_schedule_thread_invalid");
      if (!active.current || currentEpoch !== epoch.current) return;
      onReady(
        skillAutomationDraft(attempt.input, attempt.requestId),
        thread.threadId,
      );
      pending.current = null;
    } catch {
      if (active.current && currentEpoch === epoch.current)
        setError("日程准备未完成。重试会继续使用同一任务请求。");
    } finally {
      if (active.current && currentEpoch === epoch.current) {
        working.current = false;
        setBusy(false);
      }
    }
  }
  return {
    busy,
    error,
    request,
    retry: () => {
      if (pending.current) void request(pending.current.input);
    },
  };
}
