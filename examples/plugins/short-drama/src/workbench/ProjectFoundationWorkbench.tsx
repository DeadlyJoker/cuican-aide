import { useState, useSyncExternalStore, type ReactNode } from "react";
import { Pencil, Check } from "lucide-react";
import { parseProjectFoundationParameters } from "@crewon/plugin-sdk/project-foundation-ui";
import { ProjectCreationParametersFields } from "./ProjectCreationParametersFields";
import { ProjectFoundationFeedback } from "./ProjectFoundationFeedback";
import { ProjectSourceReader } from "./ProjectSourceReader";
import type { ProjectFoundationController } from "./ProjectFoundationController";
import { validBrief, type ProjectDetails } from "./creative-project-controller";
export function ProjectFoundationWorkbench({
  controller,
  details,
  briefEditor,
  sourcePage = false,
  onContinue,
}: {
  controller: ProjectFoundationController;
  details: ProjectDetails;
  briefEditor: ReactNode;
  sourcePage?: boolean;
  onContinue(): void;
}) {
  const s = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const f = s.foundation;
  const [editing, setEditing] = useState(false);
  const [parameters, setParameters] = useState(f?.parameters ?? null);
  const [editingParameters, setEditingParameters] = useState(false);
  if (!f)
    return (
      <p className="detail-note" role="status">
        {s.loading ? "正在读取创作资料…" : "此项目尚无新的创作资料。"}
      </p>
    );
  const proposal = s.proposal;
  const confirmed =
    proposal !== null &&
    f.confirmedProposal?.revision === proposal.revision &&
    f.confirmedProposal.digest === proposal.contentDigest;
  const current =
    proposal !== null &&
    proposal.foundationRevision === f.revision &&
    proposal.parametersRevision === f.parametersRevision &&
    JSON.stringify(proposal.source) === JSON.stringify(f.source);
  const blocked =
    controller.locked || s.loading || details.project.state === "archived";
  let parametersValid = false;
  try {
    parseProjectFoundationParameters(parameters, f.origin);
    parametersValid = true;
  } catch {
    /* A form cannot submit inconsistent parameters. */
  }
  return (
    <div className="drama-foundation-workbench">
      <ProjectFoundationFeedback controller={controller} snapshot={s} />
      {sourcePage ? (
        <ProjectSourceReader controller={controller} />
      ) : (
        <>
          <section className="brief-panel" aria-label="项目创作条件">
            <div className="panel-heading">
              <h3>{f.origin === "novel" ? "改编目标" : "创作想法"}</h3>
              <button
                type="button"
                className="text-button"
                disabled={blocked}
                onClick={() => {
                  setParameters(f.parameters);
                  setEditingParameters(!editingParameters);
                }}
              >
                <Pencil size={14} />
                编辑参数
              </button>
            </div>
            <p className="drama-readable-text">{details.brief.text}</p>
            <div className="brief-tags">
              <span>
                {f.parameters.episodeMode === "single"
                  ? "单集短剧"
                  : f.parameters.episodeCount
                    ? `${f.parameters.episodeCount} 集系列`
                    : "系列 · 集数待定"}
              </span>
              <span>{f.parameters.aspectRatio}</span>
              {f.parameters.genre && <span>{f.parameters.genre}</span>}
              <span>
                {f.parameters.needsCharacters ? "需要角色" : "不制作角色"}
              </span>
              <span>{f.parameters.needsArt ? "需要美术" : "不制作美术"}</span>
              {f.parameters.episodeDurationSeconds && (
                <span>
                  每集 {f.parameters.episodeDurationSeconds.minimum / 60}–
                  {f.parameters.episodeDurationSeconds.maximum / 60} 分钟
                </span>
              )}
            </div>
            {briefEditor}
            {editingParameters && parameters && (
              <form
                className="modal-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (parametersValid)
                    void controller.saveParameters(parameters).then((saved) => {
                      if (saved) setEditingParameters(false);
                    });
                }}
              >
                <ProjectCreationParametersFields
                  key={f.revision}
                  origin={f.origin}
                  value={parameters}
                  disabled={blocked}
                  onChange={setParameters}
                />
                <p className="detail-note">
                  参数变化后，需要重新确认方案；原方案仍保留。
                </p>
                <div className="detail-actions">
                  <button
                    type="button"
                    className="button secondary"
                    disabled={controller.locked}
                    onClick={() => setEditingParameters(false)}
                  >
                    取消
                  </button>
                  <button
                    className="button primary"
                    disabled={blocked || !parametersValid}
                  >
                    保存参数
                  </button>
                </div>
              </form>
            )}
          </section>
          <section
            className="brief-panel"
            aria-label={f.origin === "novel" ? "改编方案" : "创作方案"}
          >
            <div className="panel-heading">
              <h3>{f.origin === "novel" ? "改编方案" : "创作方案"}</h3>
              <span className="preview-tag">
                {confirmed
                  ? "已确认"
                  : f.creativeStartMode === "direct-script"
                    ? "已选择直接写剧本"
                    : "待确认"}
              </span>
            </div>
            {proposal ? (
              <p className="drama-readable-text">{proposal.text}</p>
            ) : (
              <p className="detail-note">
                与项目 Agent 讨论方案，或直接填写。确认后再进入后续制作。
              </p>
            )}
            {proposal && !current && !confirmed && (
              <p className="detail-note">
                创作条件或原文已变化，请修改并保存新的方案后确认。
              </p>
            )}
            <div className="detail-actions">
              <button
                type="button"
                className="button secondary"
                disabled={blocked}
                onClick={() => setEditing(!editing)}
              >
                <Pencil size={15} />
                {editing ? "收起编辑" : proposal ? "编辑方案" : "填写方案"}
              </button>
              <button
                type="button"
                className="button primary"
                disabled={
                  blocked ||
                  !current ||
                  confirmed ||
                  s.proposalDraft !== proposal?.text
                }
                onClick={() => void controller.confirmProposal()}
              >
                <Check size={15} />
                {confirmed ? "方案已确认" : "确认方案"}
              </button>
              {(confirmed || f.creativeStartMode === "direct-script") && (
                <button
                  type="button"
                  className="button secondary"
                  onClick={onContinue}
                >
                  {f.origin === "novel" ? "查看故事大纲" : "进入剧本"}
                </button>
              )}
            </div>
            {editing && (
              <form
                className="modal-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (validBrief(s.proposalDraft))
                    void controller.saveProposal().then((saved) => {
                      if (saved) setEditing(false);
                    });
                }}
              >
                <label className="form-field">
                  方案正文
                  <textarea
                    value={s.proposalDraft}
                    disabled={blocked}
                    onChange={(event) =>
                      controller.setProposalDraft(event.target.value)
                    }
                    placeholder={
                      f.origin === "novel"
                        ? "保留哪些内容？砍掉、合并什么？故事核心和风险是什么？"
                        : "故事主线、人物关系、分集安排和制作范围。"
                    }
                  />
                </label>
                <button
                  className="button primary"
                  disabled={
                    blocked ||
                    !s.latestProposalKnown ||
                    !validBrief(s.proposalDraft)
                  }
                >
                  保存方案
                </button>
              </form>
            )}
            {!s.latestProposalKnown && s.nextProposalRevision !== null && (
              <button
                type="button"
                className="button secondary"
                disabled={s.loading}
                onClick={() => void controller.continueProposals()}
              >
                继续读取方案记录
              </button>
            )}
            {f.origin === "creative" && (
              <details className="drama-secondary-disclosure">
                <summary>调整创作起点</summary>
                <p className="detail-note">
                  可明确选择直接写剧本；此操作只保存选择，不自动提交生成任务。
                </p>
                <div className="detail-actions">
                  <button
                    type="button"
                    className="button secondary"
                    disabled={
                      blocked || f.creativeStartMode === "direct-script"
                    }
                    onClick={() =>
                      void controller.chooseStartMode("direct-script")
                    }
                  >
                    直接写剧本
                  </button>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={blocked || f.creativeStartMode === "confirm-plan"}
                    onClick={() =>
                      void controller.chooseStartMode("confirm-plan")
                    }
                  >
                    先确认方案
                  </button>
                </div>
              </details>
            )}
            {s.proposals.length > 0 && (
              <details className="drama-secondary-disclosure">
                <summary>最近方案记录</summary>
                {s.proposals.map((p) => (
                  <article className="version-card" key={p.revision}>
                    <strong>
                      方案 {p.revision}
                      {f.confirmedProposal?.revision === p.revision
                        ? " · 已确认"
                        : ""}
                    </strong>
                    <p className="drama-readable-text">{p.text}</p>
                  </article>
                ))}
              </details>
            )}
          </section>
        </>
      )}
    </div>
  );
}
