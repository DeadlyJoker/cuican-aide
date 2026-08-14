import type {
  OfficeContract,
  StartOfficeDelegationRequest,
  WorkflowVersionSummaryView,
} from "@crewon/contracts";
import type { ControlApiClient } from "@crewon/control-client";
import { useEffect, useState } from "react";

import type { Locale } from "../../lib/i18n";
import { startControlOfficeDelegation } from "../../lib/office/controlOfficeRuntime";

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
  const [workflows, setWorkflows] = useState<
    readonly WorkflowVersionSummaryView[]
  >([]);
  const [workflowVersionId, setWorkflowVersionId] = useState("");
  const [input, setInput] = useState("{}");
  const [busy, setBusy] = useState(false);
  const zh = locale === "zh";

  useEffect(() => {
    let current = true;
    setOffice(null);
    setError(null);
    setRunId(null);
    setWorkflows([]);
    setWorkflowVersionId("");
    setInput("{}");
    void Promise.all([
      client.getOffice(officeVersionId),
      client.listWorkflowVersions({ limit: 100 }),
    ]).then(
      ([{ office: nextOffice }, workflowPage]) => {
        if (!current) return;
        setOffice(nextOffice);
        setWorkflows(workflowPage.data);
        setWorkflowVersionId(workflowPage.data[0]?.workflowVersionId || "");
      },
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
  async function startRun() {
    if (!workflowVersionId || !threadId) return;
    setBusy(true);
    setError(null);
    try {
      const workflowInput: unknown = JSON.parse(input);
      const response = await startControlOfficeDelegation({
        client,
        officeVersionId,
        workflowVersionId,
        threadId,
        input: workflowInput as StartOfficeDelegationRequest["input"],
      });
      setRunId(response.run.runId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ControlOfficeRoomView
      busy={busy}
      input={input}
      locale={locale}
      office={office}
      onBack={onBack}
      onInputChange={setInput}
      onStart={() => void startRun()}
      onWorkflowVersionChange={setWorkflowVersionId}
      runId={runId}
      threadId={threadId}
      workflows={workflows}
      workflowVersionId={workflowVersionId}
    />
  );
}

export function ControlOfficeRoomView({
  busy,
  input,
  locale,
  office,
  onBack,
  onInputChange,
  onStart,
  onWorkflowVersionChange,
  runId,
  threadId,
  workflows,
  workflowVersionId,
}: {
  busy: boolean;
  input: string;
  locale: Locale;
  office: OfficeContract;
  onBack: () => void;
  onInputChange: (value: string) => void;
  onStart: () => void;
  onWorkflowVersionChange: (value: string) => void;
  runId: string | null;
  threadId: string | null;
  workflows: readonly WorkflowVersionSummaryView[];
  workflowVersionId: string;
}) {
  const zh = locale === "zh";
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
        </div>
      </header>
      <div className="page-panel">
        <strong>{zh ? "成员边界" : "Member boundary"}</strong>
        {office.members.map((member) => (
          <p key={member.memberId}>
            {member.displayName} · {member.agentVersionId}
          </p>
        ))}
      </div>
      <div className="page-panel capability-field-list">
        <strong>
          {zh ? "显式 Workflow 委派" : "Explicit Workflow delegation"}
        </strong>
        <label>
          <span>{zh ? "Workflow 版本" : "Workflow version"}</span>
          <select
            value={workflowVersionId}
            onChange={(event) => onWorkflowVersionChange(event.target.value)}
          >
            {workflows.map((workflow) => (
              <option
                key={workflow.workflowVersionId}
                value={workflow.workflowVersionId}
              >
                {workflow.name} · {workflow.workflowVersionId}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{zh ? "Workflow 输入（JSON）" : "Workflow input (JSON)"}</span>
          <textarea
            rows={5}
            value={input}
            onChange={(event) => onInputChange(event.target.value)}
          />
        </label>
        {workflows.length === 0 ? (
          <p className="team-office-room-warning" role="status">
            {zh
              ? "没有可委派的 WorkflowVersion。请先在 Control 中发布 Workflow。"
              : "No WorkflowVersion is available. Publish a Workflow in Control first."}
          </p>
        ) : null}
        <button
          className="button primary"
          type="button"
          disabled={busy || !threadId || !workflowVersionId}
          onClick={onStart}
        >
          {busy
            ? zh
              ? "正在委派…"
              : "Delegating…"
            : zh
              ? "启动 Workflow"
              : "Start workflow"}
        </button>
      </div>
      {!threadId ? (
        <p className="team-office-room-warning" role="status">
          {zh
            ? "先打开一个 Control 会话，才能在该 Thread 上启动 Workflow。"
            : "Open a Control thread before starting this workflow."}
        </p>
      ) : null}
      {runId ? (
        <p className="team-office-room-warning" role="status">
          {zh ? `执行已启动：${runId}` : `Run started: ${runId}`}
        </p>
      ) : null}
      <p className="team-office-room-warning" role="note">
        {zh
          ? "Office 只定义成员边界；执行、重试、验证与恢复均由 canonical Workflow Run 负责。"
          : "Office defines the member boundary; execution, retry, verification, and recovery belong to the canonical Workflow Run."}
      </p>
    </section>
  );
}
