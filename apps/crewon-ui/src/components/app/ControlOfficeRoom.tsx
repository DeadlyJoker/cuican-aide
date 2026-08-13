import type { OfficeContract } from "@crewon/contracts";
import type { ControlApiClient } from "@crewon/control-client";
import { useEffect, useState } from "react";

import type { Locale } from "../../lib/i18n";
import { startControlOfficeRun } from "../../lib/office/controlOfficeRuntime";

export function ControlOfficeRoom({
  client,
  locale,
  officeVersionId,
  onBack,
  threadId,
}: {
  client: ControlApiClient;
  locale: Locale;
  officeVersionId: string;
  onBack: () => void;
  threadId: string | null;
}) {
  const [office, setOffice] = useState<OfficeContract | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const zh = locale === "zh";

  useEffect(() => {
    let current = true;
    setOffice(null);
    setError(null);
    void client.getOffice(officeVersionId).then(
      ({ office: nextOffice }) => current && setOffice(nextOffice),
      (cause) =>
        current &&
        setError(cause instanceof Error ? cause.message : String(cause)),
    );
    return () => {
      current = false;
    };
  }, [client, officeVersionId]);

  if (error) {
    return (
      <div className="team-office-room-error" role="alert">
        {error}
      </div>
    );
  }
  if (!office) {
    return (
      <div className="team-office-room-loading" role="status">
        {zh ? "正在从 Control 读取办公室…" : "Loading office from Control…"}
      </div>
    );
  }
  const target = office.executionTargets[0] ?? null;
  async function startRun() {
    if (!target || !threadId) return;
    setBusy(true);
    setError(null);
    try {
      const response = await startControlOfficeRun({
        client,
        officeVersionId,
        targetId: target.targetId,
        threadId,
      });
      setRunId(response.run.runId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="office-workspace-view" data-control-office-room="">
      <header className="office-workspace-header">
        <div>
          <span className="modal-kicker">CONTROL OFFICE</span>
          <h2>{office.title}</h2>
          <p>
            {office.officeVersionId} · r{office.revision}
          </p>
        </div>
        <div className="inline-actions">
          <button className="button" type="button" onClick={onBack}>
            {zh ? "返回办公室" : "Back to offices"}
          </button>
          <button
            className="button primary"
            type="button"
            disabled={busy || !threadId || !target}
            onClick={() => void startRun()}
          >
            {busy
              ? zh
                ? "正在启动…"
                : "Starting…"
              : zh
                ? "启动执行"
                : "Start run"}
          </button>
        </div>
      </header>
      <div className="page-panel">
        <strong>
          {zh ? "成员与执行目标" : "Members and execution targets"}
        </strong>
        {office.members.map((member) => (
          <p key={member.memberId}>
            {member.displayName} · {member.agentVersionId}
          </p>
        ))}
      </div>
      {!threadId ? (
        <p className="team-office-room-warning" role="status">
          {zh
            ? "先打开一个 Control 会话，才能用该 threadId 启动办公室执行。"
            : "Open a Control thread before starting this office run."}
        </p>
      ) : null}
      {runId ? (
        <p className="team-office-room-warning" role="status">
          {zh ? `执行已启动：${runId}` : `Run started: ${runId}`}
        </p>
      ) : null}
      <p className="team-office-room-warning" role="note">
        {zh
          ? "当前 Control contract 不提供 Office 群聊、delegation、retry、memory 或 verification；这些入口在此运行态不可用。"
          : "The current Control contract does not provide Office chat, delegation, retry, memory, or verification; those actions are unavailable here."}
      </p>
    </section>
  );
}
