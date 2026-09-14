import type {
  CreateAutomationRequest,
  SkillInvocationSpec,
} from "@crewon/contracts";

type ParameterBindings = CreateAutomationRequest["parameterBindings"];
type DateBinding = NonNullable<ParameterBindings>[string];

export function AutomationSkillFields({
  invocation,
  parameterBindings,
  onChange,
  onBindingsChange,
}: {
  invocation: SkillInvocationSpec;
  parameterBindings: ParameterBindings;
  onChange: (invocation: SkillInvocationSpec) => void;
  onBindingsChange: (bindings: ParameterBindings) => void;
}) {
  function setParameter(name: string, value: string | number | boolean) {
    onChange({
      ...invocation,
      parameters: { ...invocation.parameters, [name]: value },
    });
  }

  function setBinding(name: string, value: DateBinding | "literal") {
    const bindings = { ...parameterBindings };
    if (value === "literal") delete bindings[name];
    else bindings[name] = value;
    onBindingsChange(Object.keys(bindings).length === 0 ? undefined : bindings);
  }

  return (
    <section className="grid min-w-0 gap-3" aria-label="Skill 日程绑定">
      <div className="grid min-w-0 gap-1 rounded-lg border p-3">
        <strong>固定 Skill 版本</strong>
        <span className="break-all">
          {invocation.skill.skillId} · {invocation.skill.versionId}
        </span>
        <small>
          此日程始终使用这个版本。升级 Skill 后，请重新添加日程以使用新版本。
        </small>
      </div>
      {Object.entries(invocation.parameters).map(([name, value]) => (
        <div className="grid min-w-0 gap-2" key={name}>
          {typeof value === "string" ? (
            <label className="form-field">
              <span>{name} · 取值方式</span>
              <select
                value={parameterBindings?.[name] ?? "literal"}
                onChange={(event) =>
                  setBinding(
                    name,
                    event.target.value as DateBinding | "literal",
                  )
                }
              >
                <option value="literal">固定值</option>
                <option value="runDate">运行日期</option>
                <option value="previousWeekStart">
                  上一完整周开始（周一）
                </option>
                <option value="previousWeekEnd">上一完整周结束（周日）</option>
              </select>
            </label>
          ) : null}
          {parameterBindings?.[name] ? (
            <p className="text-sm text-muted-foreground">
              {name} 会按日程时区自动计算，格式为 YYYY-MM-DD。
            </p>
          ) : (
            <label className="form-field">
              <span>{name}</span>
              {typeof value === "boolean" ? (
                <select
                  value={String(value)}
                  onChange={(event) =>
                    setParameter(name, event.target.value === "true")
                  }
                >
                  <option value="true">是</option>
                  <option value="false">否</option>
                </select>
              ) : typeof value === "number" ? (
                <input
                  required
                  type="number"
                  step="any"
                  value={Number.isFinite(value) ? value : ""}
                  onChange={(event) =>
                    setParameter(
                      name,
                      event.target.value === ""
                        ? Number.NaN
                        : Number(event.target.value),
                    )
                  }
                />
              ) : (
                <input
                  type="text"
                  maxLength={2048}
                  value={value}
                  onChange={(event) => setParameter(name, event.target.value)}
                />
              )}
            </label>
          )}
        </div>
      ))}
      {invocation.deliveryTarget ? (
        <div className="grid min-w-0 gap-1 rounded-lg border p-3">
          <strong>已选交付目标</strong>
          <span className="break-all">
            对话：{invocation.deliveryTarget.threadId}
          </span>
          <small>交付到此对话的成果集合；保存和执行时都会重新校验权限。</small>
        </div>
      ) : null}
    </section>
  );
}
