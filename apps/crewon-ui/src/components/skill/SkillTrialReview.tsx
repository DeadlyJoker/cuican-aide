import { useState } from "react";
import type { SkillVersion } from "@crewon/domain/demonstrated-skill";
import type {
  SkillCoverage,
  SkillExecutionView,
  SkillReviewInput,
} from "../../lib/skill/demonstratedSkillClient";

const coverageOptions: readonly {
  value: SkillCoverage;
  label: string;
  short: string;
}[] = [
  { value: "new-date", label: "使用了新日期", short: "新日期" },
  { value: "new-input", label: "使用了新输入", short: "新输入" },
  { value: "handled-exception", label: "核对了已知异常", short: "已知异常" },
];
const statuses: Record<string, string> = {
  pending: "等待提交",
  queued: "排队中",
  running: "试跑中",
  completed: "运行完成",
  failed: "运行失败",
  cancelled: "已取消",
  interrupted: "已中断",
  blocked: "等待处理",
};
export function isReviewedRealTrial(
  execution: SkillExecutionView,
  version: SkillVersion,
): boolean {
  const review = execution.review;
  return (
    execution.purpose === "trial" &&
    execution.status === "completed" &&
    execution.verification === "real" &&
    !!execution.runId &&
    execution.invocation.skill.skillId === version.ref.skillId &&
    execution.invocation.skill.versionId === version.ref.versionId &&
    execution.invocation.skill.contentDigest === version.ref.contentDigest &&
    !!review &&
    version.method.completionCriteria.every((criterion) =>
      review.criteria.includes(criterion),
    ) &&
    review.coverage.some((item) => item === "new-date" || item === "new-input")
  );
}

export function SkillTrialReview({
  execution,
  version,
  busy,
  onReview,
  onOpenRun,
}: {
  execution: SkillExecutionView;
  version: SkillVersion;
  busy: boolean;
  onReview: (review: SkillReviewInput) => void;
  onOpenRun?: (runId: string) => void;
}) {
  const [criteria, setCriteria] = useState<string[]>([]);
  const [coverage, setCoverage] = useState<SkillCoverage[]>([]);
  const [resultNote, setResultNote] = useState("");
  const canReview =
    execution.purpose === "trial" &&
    execution.status === "completed" &&
    execution.verification === "real" &&
    !!execution.runId &&
    !execution.review;
  const complete =
    version.method.completionCriteria.every((criterion) =>
      criteria.includes(criterion),
    ) &&
    coverage.some((value) => value === "new-date" || value === "new-input") &&
    resultNote.trim().length > 0;
  const uncovered = coverageOptions.filter(
    (item) => !execution.review?.coverage.includes(item.value),
  );
  return (
    <article className="demonstrated-skill-trial">
      <header>
        <strong>{statuses[execution.status] ?? "状态待确认"}</strong>
        <span>
          {execution.verification === "real"
            ? "真实执行"
            : execution.verification === "simulated"
              ? "模拟执行，不能用于激活"
              : "真实性待验证，不能用于激活"}
        </span>
      </header>
      <p className="demonstrated-skill-note">
        版本 {execution.invocation.skill.versionId} · {execution.createdAt}
      </p>
      <dl>
        {Object.entries(execution.invocation.parameters).map(([key, value]) => (
          <div key={key}>
            <dt>
              {version.method.parameters.find(
                (parameter) => parameter.name === key,
              )?.label ?? key}
            </dt>
            <dd>{String(value)}</dd>
          </div>
        ))}
      </dl>
      {execution.runId && onOpenRun ? (
        <button
          className="button compact"
          type="button"
          onClick={() => onOpenRun(execution.runId!)}
        >
          查看运行结果
        </button>
      ) : null}
      {execution.review ? (
        <>
          <p>
            {isReviewedRealTrial(execution, version)
              ? "已核对通过"
              : "核对记录尚不满足激活要求"}
          </p>
          {execution.review.resultNote ? (
            <p>{execution.review.resultNote}</p>
          ) : null}
          <p className="demonstrated-skill-note">
            {uncovered.length
              ? `尚未覆盖：${uncovered.map((item) => item.short).join("、")}`
              : "已覆盖新日期、新输入与已知异常"}
          </p>
        </>
      ) : null}
      {canReview ? (
        <fieldset aria-label="核对试跑结果" disabled={busy}>
          <legend>对照实际结果核对</legend>
          {version.method.completionCriteria.map((criterion) => (
            <label className="demonstrated-skill-check" key={criterion}>
              <input
                aria-label={`已核对：${criterion}`}
                type="checkbox"
                checked={criteria.includes(criterion)}
                onChange={(event) =>
                  setCriteria(
                    event.target.checked
                      ? [...criteria, criterion]
                      : criteria.filter((value) => value !== criterion),
                  )
                }
              />
              {criterion}
            </label>
          ))}
          {coverageOptions.map((item) => (
            <label className="demonstrated-skill-check" key={item.value}>
              <input
                aria-label={item.label}
                type="checkbox"
                checked={coverage.includes(item.value)}
                onChange={(event) =>
                  setCoverage(
                    event.target.checked
                      ? [...coverage, item.value]
                      : coverage.filter((value) => value !== item.value),
                  )
                }
              />
              {item.label}
            </label>
          ))}
          <label className="form-field">
            <span>结果核对说明</span>
            <textarea
              aria-label="结果核对说明"
              rows={3}
              value={resultNote}
              onChange={(event) => setResultNote(event.target.value)}
            />
          </label>
          <p className="demonstrated-skill-note">
            至少核对一次新日期或新输入的真实试跑。未覆盖的情况会继续显示。
          </p>
          <button
            className="button compact"
            type="button"
            disabled={!complete}
            onClick={() =>
              onReview({ criteria, coverage, resultNote: resultNote.trim() })
            }
          >
            确认核对结果
          </button>
        </fieldset>
      ) : null}
    </article>
  );
}
