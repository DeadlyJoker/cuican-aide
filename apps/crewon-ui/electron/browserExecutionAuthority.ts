import { parseBrowserExecutionAuthorityResponse } from "@crewon/contracts";
import type { ControlRuntimeSession } from "./runtimeSupervisor.ts";
import type { BrowserRunIdentity } from "./browserExecutionGrants.ts";
import type { BrowserExecutionAuthority } from "./browserExecutionHost.ts";

const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Uses current desktop Control credentials for every read; no recorder-derived scope. */
export function createBrowserExecutionAuthority(
  session: () => ControlRuntimeSession,
): BrowserExecutionAuthority {
  async function read(
    path: string,
    absentSkillAllowed = false,
  ): Promise<unknown> {
    const current = session(); // Preserve an unavailable Supervisor error instead of inventing authority.
    const base = new URL(current.baseUrl);
    if (
      base.protocol !== "http:" ||
      base.hostname !== "127.0.0.1" ||
      base.username ||
      base.password ||
      base.pathname !== "/" ||
      base.search ||
      base.hash ||
      !current.sessionToken ||
      /\s/u.test(current.sessionToken) ||
      new URL(current.origin).origin !== current.origin
    )
      throw new Error("browser_control_session_invalid");
    const response = await fetch(new URL(path, base), {
      method: "GET",
      headers: {
        authorization: `Bearer ${current.sessionToken}`,
        origin: current.origin,
        accept: "application/json",
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(3000),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      if (absentSkillAllowed && response.status === 404) return null;
      throw new Error(`browser_control_http_${response.status}`);
    }
    if (
      response.headers
        .get("content-type")
        ?.split(";")[0]
        ?.trim()
        .toLowerCase() !== "application/json" ||
      response.body === null
    ) {
      await response.body?.cancel();
      throw new Error("browser_control_response_invalid");
    }
    if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
      await response.body.cancel();
      throw new Error("browser_control_response_limit");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES)
          throw new Error("browser_control_response_limit");
        chunks.push(value);
      }
      try {
        return JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(chunks),
          ),
        );
      } catch {
        throw new Error("browser_control_response_invalid");
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  async function checkThread(threadId: string): Promise<void> {
    opaque(threadId, "browser_control_thread_invalid");
    const result = record(
      await read(`/api/v1/threads/${encodeURIComponent(threadId)}`),
      "browser_control_thread_invalid",
    );
    const thread = record(result.thread, "browser_control_thread_invalid");
    if (
      Object.keys(result).sort().join() !== "eventSequence,thread" ||
      thread.threadId !== threadId ||
      !["active", "archived"].includes(String(thread.status)) ||
      !Number.isSafeInteger(thread.revision) ||
      Number(thread.revision) < 1 ||
      result.eventSequence !== thread.revision
    )
      throw new Error("browser_control_thread_invalid");
  }

  async function resolveRun(runId: string): Promise<BrowserRunIdentity> {
    opaque(runId, "browser_control_run_invalid");
    const facts = parseBrowserExecutionAuthorityResponse(
      await read(
        `/api/v1/runs/${encodeURIComponent(runId)}/browser-execution-authority`,
      ),
      runId,
    );
    await checkThread(facts.threadId);
    const skill = parseSkill(
      await read(
        `/api/v1/runs/${encodeURIComponent(runId)}/skill-invocation`,
        true,
      ),
      facts.threadId,
    );
    return {
      runId: facts.runId,
      threadId: facts.threadId,
      workspaceBindingId: facts.workspaceBindingId,
      active:
        !facts.cancelRequested &&
        (facts.status === "running" || facts.status === "reconciling"),
      skill,
    };
  }
  return { checkThread, resolveRun };
}

function parseSkill(
  input: unknown,
  threadId: string,
): BrowserRunIdentity["skill"] {
  if (input === null) return null;
  const code = "browser_control_skill_invalid";
  const value = record(input, code);
  if (
    Object.keys(value).sort().join() !==
      "parameters,skillVersionRef,threadId" ||
    value.threadId !== threadId
  )
    throw new Error(code);
  const ref = record(value.skillVersionRef, code);
  if (Object.keys(ref).sort().join() !== "contentDigest,skillId,versionId")
    throw new Error(code);
  opaque(ref.skillId, code);
  opaque(ref.versionId, code);
  if (
    typeof ref.contentDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(ref.contentDigest)
  )
    throw new Error(code);
  const parameters = record(value.parameters, code);
  return {
    ref: {
      skillId: ref.skillId as string,
      versionId: ref.versionId as string,
      contentDigest: ref.contentDigest,
    },
    parameters: structuredClone(parameters),
  };
}
function record(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(code);
  return value as Record<string, unknown>;
}
function opaque(value: unknown, code: string): void {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
  )
    throw new Error(code);
}
