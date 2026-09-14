import { useEffect, useRef, useState } from "react";
import {
  parseSkillMethod,
  validateSkillInvocation,
  type SkillInvocationSpec,
  type SkillMethod,
  type SkillVersion,
} from "@crewon/domain/demonstrated-skill";
import type {
  DemonstratedSkillClient,
  DemonstratedSkillDetail,
  SkillExecutionTarget,
  SkillExecutionAttempt,
  SkillExecutionAttemptStore,
  SkillGenerationAttemptStore,
  SkillExecutionInput,
} from "../../lib/skill/demonstratedSkillClient";
import { SkillMethodEditor } from "./SkillMethodEditor";
import { SkillDraftGeneration } from "./SkillDraftGeneration";
import {
  SkillBrowserAuthorization,
  needsSkillBrowserAuthorization,
} from "./SkillBrowserAuthorization";
import type {
  BrowserExecutionBridge,
  BrowserGrantScope,
} from "../../lib/browser-execution/browserExecutionGrant";
import { isReviewedRealTrial, SkillTrialReview } from "./SkillTrialReview";
import { skillClientKey, useSkillOperationScope } from "./skillClientScope";
import "./demonstrated-skill.css";

export type DemonstratedSkillPanelProps = {
  skillId: string;
  client: DemonstratedSkillClient;
  executionTarget: SkillExecutionTarget | null;
  prepareExecutionTarget?: (
    executionId: string,
  ) => Promise<SkillExecutionTarget>;
  executionAttemptStore?: SkillExecutionAttemptStore;
  generationAttemptStore?: SkillGenerationAttemptStore;
  browserScope?: BrowserGrantScope;
  browserBridge?: BrowserExecutionBridge;
  deliveryTarget?: SkillInvocationSpec["deliveryTarget"];
  onAddToSchedule?: (draft: {
    title: string;
    invocation: SkillInvocationSpec;
  }) => void;
  onOpenRun?: (runId: string) => void;
};

export function DemonstratedSkillPanel(props: DemonstratedSkillPanelProps) {
  return (
    <SkillPanelContent
      key={`${skillClientKey(props.client)}:${props.skillId}`}
      {...props}
    />
  );
}

function errorText(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  if (code.includes("revision"))
    return "内容已在另一处更新。请刷新后重新审阅并保存。";
  if (code.includes("trial") || code.includes("review"))
    return "需要先完成真实试跑并核对结果。";
  if (code.includes("parameter")) return "请检查变量名称、类型和必填值。";
  if (code.includes("too_large") || code.includes("budget"))
    return "方法内容过长，请精简步骤和说明后重试。";
  if (
    code.includes("disabled") ||
    code.includes("denied") ||
    code.includes("revoked")
  )
    return "此 Skill 已禁用或授权已撤回，当前操作未执行。";
  if (code.includes("tool") || code.includes("capability"))
    return "所选执行目标缺少此 Skill 需要的工具或授权。";
  if (code.includes("shape") || code.includes("text") || code.includes("list"))
    return "请填写完整的方法、完成标准与已知异常。";
  return "操作未完成，请检查连接并重试。";
}

function cleanMethod(method: SkillMethod): SkillMethod {
  const tidy = (values: readonly string[]) =>
    values.map((value) => value.trim()).filter(Boolean);
  return parseSkillMethod({
    ...method,
    name: method.name.trim(),
    purpose: method.purpose.trim(),
    steps: tidy(method.steps),
    requiredToolRefs: tidy(method.requiredToolRefs),
    completionCriteria: tidy(method.completionCriteria),
    knownExceptions: tidy(method.knownExceptions),
    runtimeRequirements: tidy(method.runtimeRequirements),
    parameters: method.parameters.map((field) => ({
      ...field,
      ...(field.enum ? { enum: tidy(field.enum) } : {}),
    })),
  });
}

function SkillPanelContent({
  skillId,
  client,
  executionTarget,
  prepareExecutionTarget,
  executionAttemptStore,
  generationAttemptStore,
  browserScope,
  browserBridge,
  deliveryTarget,
  onAddToSchedule,
  onOpenRun,
}: DemonstratedSkillPanelProps) {
  const captureScope = useSkillOperationScope(client);
  const [detail, setDetail] = useState<DemonstratedSkillDetail | null>(null);
  const [draft, setDraft] = useState<SkillMethod | null>(null);
  const executionAttempt = useRef<SkillExecutionAttempt | null>(
    executionAttemptStore?.get() ?? null,
  );
  const [versionId, setVersionId] = useState(
    executionAttempt.current?.invocation.skill.versionId ?? "",
  );
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(executionAttempt.current?.invocation.parameters ?? {}).map(
        ([key, value]) => [key, String(value)],
      ),
    ),
  );
  const [busy, setBusy] = useState(false);
  const [generationApplying, setGenerationApplying] = useState(false);
  const [browserCommand, setBrowserCommand] =
    useState<SkillExecutionInput | null>(() => {
      const command = executionAttempt.current?.command;
      return command &&
        needsSkillBrowserAuthorization(command.invocation.requiredToolRefs)
        ? command
        : null;
    });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [retryPurpose, setRetryPurpose] = useState<"trial" | "execute" | null>(
    executionAttempt.current?.purpose ?? null,
  );
  const busyRef = useRef(false);
  const readSequence = useRef(0);

  async function refresh(options?: {
    replaceDraft?: boolean;
    selectNewest?: boolean;
  }) {
    const isCurrent = captureScope();
    if (!isCurrent()) return;
    const sequence = ++readSequence.current;
    const next = await client.read(skillId);
    if (!isCurrent() || sequence !== readSequence.current) return;
    setDetail(next);
    if (options?.selectNewest) setBrowserCommand(null);
    if (
      executionAttempt.current &&
      next.executions.some(
        (item) =>
          item.executionId === executionAttempt.current?.executionId &&
          item.runId,
      )
    ) {
      executionAttempt.current = null;
      executionAttemptStore?.set(null);
      setRetryPurpose(null);
    }
    setDraft((current) =>
      options?.replaceDraft || !current ? next.skill.draft : current,
    );
    const newest = [...next.versions].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    )[0];
    setVersionId((current) =>
      options?.selectNewest ||
      !next.versions.some((v) => v.ref.versionId === current)
        ? (newest?.ref.versionId ?? "")
        : current,
    );
  }
  useEffect(() => {
    const isCurrent = captureScope();
    void refresh().catch((failure: unknown) => {
      if (isCurrent()) setError(errorText(failure));
    });
    return () => {
      readSequence.current += 1;
    };
  }, [client, skillId]);

  const pending = detail?.executions.some((item) =>
    ["pending", "queued", "running"].includes(item.status),
  );
  useEffect(() => {
    if (!pending) return;
    const isCurrent = captureScope();
    const interval = window.setInterval(() => {
      if (!busyRef.current)
        void refresh().catch(() => {
          if (isCurrent()) setError("试跑状态暂未更新，请刷新重试。");
        });
    }, 3000);
    return () => window.clearInterval(interval);
  }, [pending, client, skillId]);

  async function run(
    action: () => Promise<void>,
    success: string | (() => string),
    options?: { replaceDraft?: boolean; selectNewest?: boolean },
  ) {
    const isCurrent = captureScope();
    if (busyRef.current || !isCurrent()) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      if (!isCurrent()) return;
      await refresh(options);
      if (isCurrent())
        setNotice(typeof success === "function" ? success() : success);
    } catch (failure) {
      if (isCurrent()) setError(errorText(failure));
    } finally {
      if (isCurrent()) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }

  async function submitExecution(
    purpose: "trial" | "execute",
    invocation: SkillInvocationSpec,
  ) {
    const isCurrent = captureScope();
    if (!isCurrent()) return;
    if (
      executionAttempt.current &&
      executionAttempt.current.purpose !== purpose
    )
      return;
    const attempt = executionAttempt.current ?? {
      executionId: crypto.randomUUID(),
      purpose,
      invocation: structuredClone(invocation),
      command: null,
    };
    executionAttempt.current = attempt;
    executionAttemptStore?.set(attempt);
    setRetryPurpose(purpose);
    let waitingForBrowser = false;
    await run(
      async () => {
        if (!attempt.command) {
          const target = prepareExecutionTarget
            ? await prepareExecutionTarget(attempt.executionId)
            : executionTarget;
          if (!isCurrent()) return;
          if (!target) throw new Error("skill_execution_target_required");
          attempt.command = {
            ...target,
            executionId: attempt.executionId,
            purpose: attempt.purpose,
            invocation: attempt.invocation,
          };
        }
        if (!isCurrent()) return;
        if (
          needsSkillBrowserAuthorization(attempt.invocation.requiredToolRefs)
        ) {
          setBrowserCommand(attempt.command);
          if (!attempt.browserChoice) {
            waitingForBrowser = true;
            return;
          }
        }
        await client.startExecution(skillId, attempt.command);
      },
      () =>
        waitingForBrowser
          ? "任务已准备，请确认浏览器执行方式。"
          : purpose === "trial"
            ? "试跑已提交，等待真实运行结果"
            : "调用已提交",
    );
  }

  if (!detail || !draft)
    return (
      <section className="demonstrated-skill-panel" aria-label="示教 Skill">
        {error ? (
          <>
            <p role="alert">{error}</p>
            <button
              className="button compact"
              onClick={() => void run(async () => {}, "已刷新")}
            >
              重新加载
            </button>
          </>
        ) : (
          <p role="status">正在加载示教 Skill…</p>
        )}
      </section>
    );
  const skill = detail.skill;
  const version = detail.versions.find(
    (item) => item.ref.versionId === versionId,
  );
  const disabled = skill.disabled || skill.deleted;
  const dirty = JSON.stringify(draft) !== JSON.stringify(skill.draft);
  const activated =
    !!version && skill.activatedVersionIds.includes(version.ref.versionId);
  const sample =
    skill.source.provenance === "contract-fixture" ||
    version?.source.provenance === "contract-fixture";
  const trials = version
    ? detail.executions.filter(
        (item) =>
          item.invocation.skill.versionId === version.ref.versionId &&
          item.invocation.skill.contentDigest === version.ref.contentDigest,
      )
    : [];
  const verified =
    !!version && trials.some((trial) => isReviewedRealTrial(trial, version));
  let invocation: SkillInvocationSpec | null = null;
  if (version) {
    try {
      const parameters = Object.fromEntries(
        version.method.parameters.flatMap((field) => {
          const value = values[field.name];
          if (value === undefined || value.trim() === "") return [];
          return [
            [
              field.name,
              field.type === "boolean"
                ? value === "true"
                : field.type === "number"
                  ? Number(value)
                  : value,
            ],
          ];
        }),
      );
      invocation = validateSkillInvocation(version.method, {
        schemaVersion: "crewon.skill-invocation.v1",
        ...(deliveryTarget ? { deliveryTarget } : {}),
        skill: version.ref,
        parameters,
        requiredToolRefs: version.method.requiredToolRefs,
      });
    } catch {
      /* The field-level input remains visible until valid. */
    }
  }
  const canExecute =
    !busy &&
    !disabled &&
    (!!executionTarget || !!prepareExecutionTarget) &&
    !!invocation;
  const awaitingBrowserChoice =
    !!browserCommand &&
    executionAttempt.current?.executionId === browserCommand.executionId &&
    !executionAttempt.current.browserChoice;

  return (
    <section
      className="demonstrated-skill-panel"
      aria-label="示教 Skill"
      aria-busy={busy}
    >
      <header className="demonstrated-skill-heading">
        <div>
          <span className="demonstrated-skill-note">示教 Skill</span>
          <h2>{skill.draft.name}</h2>
          <p>
            {disabled
              ? "已禁用 · 新执行已暂停"
              : activated
                ? "已激活"
                : verified
                  ? "试跑已核对 · 待确认激活"
                  : "待试跑"}
          </p>
        </div>
        <button
          className="button compact"
          type="button"
          disabled={busy}
          onClick={() => void run(async () => {}, "已刷新")}
        >
          刷新状态
        </button>
      </header>
      {sample ? (
        <p className="demonstrated-skill-warning">
          契约样本：用于开发验证，尚未来自真实录制，不能激活。
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="catalog-resource-error">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="demonstrated-skill-note">
          {notice}
        </p>
      ) : null}
      <div className="demonstrated-skill-columns">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(
              () =>
                client.saveDraft(skillId, skill.revision, cleanMethod(draft)),
              "草稿已保存",
              { replaceDraft: true },
            );
          }}
        >
          <SkillDraftGeneration
            skillId={skillId}
            expectedSkillRevision={skill.revision}
            draftDirty={dirty}
            disabled={busy || disabled || sample}
            client={client}
            executionTarget={executionTarget}
            prepareExecutionTarget={prepareExecutionTarget}
            attemptStore={generationAttemptStore}
            onOpenRun={onOpenRun}
            onApplyingChange={setGenerationApplying}
            onApplied={() =>
              run(async () => {}, "模型候选已采用，请审阅并保存新版本", {
                replaceDraft: true,
              })
            }
          />
          <SkillMethodEditor
            method={draft}
            disabled={busy || generationApplying || skill.deleted}
            onChange={setDraft}
          />
          <footer className="demonstrated-skill-actions">
            <button
              className="button compact"
              type="submit"
              disabled={busy || generationApplying || !dirty || skill.deleted}
            >
              保存草稿
            </button>
            <button
              className="button primary compact"
              type="button"
              disabled={
                busy ||
                generationApplying ||
                dirty ||
                skill.deleted ||
                retryPurpose !== null
              }
              onClick={() =>
                void run(
                  () => client.createVersion(skillId, skill.revision),
                  "已保存新版本，请填写新材料试跑",
                  { selectNewest: true },
                )
              }
            >
              保存新版本
            </button>
          </footer>
          <p className="demonstrated-skill-note">
            {dirty
              ? "先保存草稿，再创建试跑版本。"
              : "已保存版本保持不变。修正草稿后创建新版本，旧任务继续使用原版本。"}
          </p>
        </form>
        <div className="demonstrated-skill-execution">
          <h3>版本与试跑</h3>
          {version ? (
            <>
              <label className="form-field">
                <span>固定版本</span>
                <select
                  aria-label="固定版本"
                  value={versionId}
                  disabled={busy || retryPurpose !== null}
                  onChange={(event) => {
                    setVersionId(event.target.value);
                    setValues({});
                    setBrowserCommand(null);
                  }}
                >
                  {detail.versions.map((item) => (
                    <option key={item.ref.versionId} value={item.ref.versionId}>
                      {item.ref.versionId}
                      {skill.activatedVersionIds.includes(item.ref.versionId)
                        ? " · 已激活"
                        : " · 待验证"}
                    </option>
                  ))}
                </select>
              </label>
              <p className="demonstrated-skill-note">
                {version.createdAt} · {version.ref.contentDigest.slice(0, 19)}…
              </p>
              <details className="demonstrated-skill-version-method">
                <summary>查看此版本的方法</summary>
                <VersionMethod version={version} />
              </details>
              <p className="demonstrated-skill-note">
                换一个日期或一份新输入，核对实际结果后再激活。
              </p>
              {version.method.parameters.map((field) => (
                <label className="form-field" key={field.name}>
                  <span>
                    {field.label}
                    {field.required ? " *" : "（选填）"}
                  </span>
                  {field.type === "boolean" || field.enum ? (
                    <select
                      aria-label={`试跑参数：${field.label}`}
                      disabled={busy || retryPurpose !== null}
                      value={values[field.name] ?? ""}
                      onChange={(event) =>
                        setValues({
                          ...values,
                          [field.name]: event.target.value,
                        })
                      }
                    >
                      <option value="">请选择</option>
                      {field.enum ? (
                        field.enum.map((value) => (
                          <option key={value}>{value}</option>
                        ))
                      ) : (
                        <>
                          <option value="true">是</option>
                          <option value="false">否</option>
                        </>
                      )}
                    </select>
                  ) : (
                    <input
                      aria-label={`试跑参数：${field.label}`}
                      disabled={busy || retryPurpose !== null}
                      autoComplete="off"
                      type={field.type === "number" ? "number" : "text"}
                      value={values[field.name] ?? ""}
                      onChange={(event) =>
                        setValues({
                          ...values,
                          [field.name]: event.target.value,
                        })
                      }
                    />
                  )}
                </label>
              ))}
              {!executionTarget && !prepareExecutionTarget ? (
                <p className="demonstrated-skill-note">
                  选择一个任务和可执行 Agent 后即可试跑。
                </p>
              ) : null}
              {retryPurpose && !awaitingBrowserChoice ? (
                <p role="status" className="demonstrated-skill-note">
                  本次提交状态待确认。重试将继续使用原参数和同一个执行标识。
                </p>
              ) : null}
              {browserCommand ? (
                <SkillBrowserAuthorization
                  command={browserCommand}
                  awaitingChoice={awaitingBrowserChoice}
                  busy={busy}
                  scope={browserScope}
                  bridge={browserBridge}
                  onProceed={(choice) => {
                    const attempt = executionAttempt.current;
                    if (
                      !attempt ||
                      attempt.executionId !== browserCommand.executionId ||
                      busy
                    )
                      return;
                    attempt.browserChoice = choice;
                    void submitExecution(attempt.purpose, attempt.invocation);
                  }}
                />
              ) : null}
              <div
                className="demonstrated-skill-actions"
                hidden={awaitingBrowserChoice}
              >
                <button
                  className="button primary compact"
                  type="button"
                  disabled={!canExecute || retryPurpose === "execute"}
                  onClick={() => {
                    if (invocation) void submitExecution("trial", invocation);
                  }}
                >
                  {retryPurpose === "trial" ? "重试原试跑" : "开始试跑"}
                </button>
                {activated ? (
                  <button
                    className="button compact"
                    type="button"
                    disabled={!canExecute || retryPurpose === "trial"}
                    onClick={() => {
                      if (invocation)
                        void submitExecution("execute", invocation);
                    }}
                  >
                    {retryPurpose === "execute" ? "重试原调用" : "运行此版本"}
                  </button>
                ) : null}
              </div>
              <div className="demonstrated-skill-trials" aria-label="运行记录">
                {trials.length ? (
                  trials.map((trial) => (
                    <SkillTrialReview
                      key={trial.executionId}
                      execution={trial}
                      version={version}
                      busy={busy}
                      onOpenRun={onOpenRun}
                      onReview={(review) =>
                        void run(
                          () =>
                            client.reviewExecution(
                              skillId,
                              trial.executionId,
                              review,
                            ),
                          "核对结果已保存",
                        )
                      }
                    />
                  ))
                ) : (
                  <p className="demonstrated-skill-note">
                    此版本还没有试跑记录。
                  </p>
                )}
              </div>
              <div className="demonstrated-skill-actions">
                {!activated ? (
                  <button
                    className="button primary compact"
                    type="button"
                    disabled={busy || disabled || sample || !verified}
                    onClick={() =>
                      void run(
                        () =>
                          client.activate(skillId, skill.revision, version.ref),
                        "此版本已激活",
                      )
                    }
                  >
                    确认激活
                  </button>
                ) : null}
                {activated && onAddToSchedule ? (
                  <button
                    className="button compact"
                    type="button"
                    disabled={busy || disabled || !invocation || sample}
                    onClick={() => {
                      if (invocation)
                        onAddToSchedule({
                          title: version.method.name,
                          invocation,
                        });
                    }}
                  >
                    添加到日程
                  </button>
                ) : null}
                {!skill.deleted ? (
                  <button
                    className="button compact"
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () =>
                          client.setDisabled(
                            skillId,
                            skill.revision,
                            !skill.disabled,
                          ),
                        skill.disabled
                          ? "Skill 已重新启用"
                          : "Skill 已禁用，新执行已暂停",
                      )
                    }
                  >
                    {skill.disabled ? "重新启用 Skill" : "禁用 Skill"}
                  </button>
                ) : null}
              </div>
            </>
          ) : (
            <p className="demonstrated-skill-note">
              审阅草稿后保存新版本，即可开始试跑。
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function VersionMethod({ version }: { version: SkillVersion }) {
  const { method } = version;
  return (
    <div>
      <p>{method.purpose}</p>
      <ol>
        {method.steps.map((step, index) => (
          <li key={index}>{step}</li>
        ))}
      </ol>
      <h4>完成标准</h4>
      <ul>
        {method.completionCriteria.map((text) => (
          <li key={text}>{text}</li>
        ))}
      </ul>
      <h4>已知异常</h4>
      <ul>
        {method.knownExceptions.map((text) => (
          <li key={text}>{text}</li>
        ))}
      </ul>
      <h4>依赖工具</h4>
      <p>{method.requiredToolRefs.join("、") || "无"}</p>
      <h4>运行时授权与准备</h4>
      <ul>
        {method.runtimeRequirements.map((text) => (
          <li key={text}>{text}</li>
        ))}
      </ul>
    </div>
  );
}
