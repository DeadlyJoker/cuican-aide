import type {
  SkillMethod,
  SkillParameter,
} from "@crewon/domain/demonstrated-skill";

const listFields = [
  ["steps", "方法步骤", 5],
  ["requiredToolRefs", "依赖工具", 2],
  ["completionCriteria", "完成标准", 3],
  ["knownExceptions", "已知异常", 3],
  ["runtimeRequirements", "运行时授权与准备", 2],
] as const;
const lines = (value: string) => value.split("\n");

export function SkillMethodEditor({
  method,
  disabled,
  onChange,
}: {
  method: SkillMethod;
  disabled: boolean;
  onChange: (method: SkillMethod) => void;
}) {
  function updateParameter(index: number, field: SkillParameter) {
    onChange({
      ...method,
      parameters: method.parameters.map((value, i) =>
        i === index ? field : value,
      ),
    });
  }
  return (
    <fieldset className="demonstrated-skill-method" disabled={disabled}>
      <legend>审阅与修正草稿</legend>
      <label className="form-field">
        <span>名称</span>
        <input
          aria-label="名称"
          required
          value={method.name}
          onChange={(event) =>
            onChange({ ...method, name: event.target.value })
          }
        />
      </label>
      <label className="form-field">
        <span>用途</span>
        <textarea
          aria-label="用途"
          required
          rows={2}
          value={method.purpose}
          onChange={(event) =>
            onChange({ ...method, purpose: event.target.value })
          }
        />
      </label>
      {listFields.map(([key, label, rows]) => (
        <label className="form-field" key={key}>
          <span>
            {label}
            <small>每行一项</small>
          </span>
          <textarea
            aria-label={label}
            rows={rows}
            value={method[key].join("\n")}
            onChange={(event) =>
              onChange({ ...method, [key]: lines(event.target.value) })
            }
          />
        </label>
      ))}
      <div className="demonstrated-skill-parameters">
        <h3>变量</h3>
        <p className="demonstrated-skill-note">
          日期、报表范围等可在每次运行时填写。登录凭据请在运行时授权提供。
        </p>
        {method.parameters.map((field, index) => (
          <div className="demonstrated-skill-parameter-editor" key={index}>
            <label className="form-field">
              <span>变量名称</span>
              <input
                aria-label={`变量 ${index + 1} 名称`}
                value={field.name}
                onChange={(event) =>
                  updateParameter(index, { ...field, name: event.target.value })
                }
              />
            </label>
            <label className="form-field">
              <span>显示名称</span>
              <input
                aria-label={`变量 ${index + 1} 显示名称`}
                value={field.label}
                onChange={(event) =>
                  updateParameter(index, {
                    ...field,
                    label: event.target.value,
                  })
                }
              />
            </label>
            <label className="form-field">
              <span>类型</span>
              <select
                aria-label={`变量 ${index + 1} 类型`}
                value={field.type}
                onChange={(event) => {
                  const { enum: _enum, ...rest } = field;
                  updateParameter(index, {
                    ...rest,
                    type: event.target.value as SkillParameter["type"],
                  });
                }}
              >
                <option value="string">文字</option>
                <option value="number">数字</option>
                <option value="boolean">是 / 否</option>
              </select>
            </label>
            <label className="demonstrated-skill-check">
              <input
                type="checkbox"
                checked={field.required}
                onChange={(event) =>
                  updateParameter(index, {
                    ...field,
                    required: event.target.checked,
                  })
                }
              />
              必填
            </label>
            {field.type === "string" ? (
              <label className="form-field">
                <span>
                  可选值<small>每行一项，留空可自由填写</small>
                </span>
                <textarea
                  aria-label={`变量 ${index + 1} 可选值`}
                  rows={2}
                  value={field.enum?.join("\n") ?? ""}
                  onChange={(event) => {
                    const { enum: _enum, ...rest } = field;
                    updateParameter(
                      index,
                      event.target.value
                        ? { ...rest, enum: lines(event.target.value) }
                        : rest,
                    );
                  }}
                />
              </label>
            ) : null}
            <button
              className="button compact"
              type="button"
              onClick={() =>
                onChange({
                  ...method,
                  parameters: method.parameters.filter((_, i) => i !== index),
                })
              }
            >
              移除变量 {index + 1}
            </button>
          </div>
        ))}
        <button
          className="button compact"
          type="button"
          disabled={method.parameters.length >= 24}
          onClick={() =>
            onChange({
              ...method,
              parameters: [
                ...method.parameters,
                {
                  name: `input${method.parameters.length + 1}`,
                  label: "新变量",
                  type: "string",
                  required: true,
                },
              ],
            })
          }
        >
          添加变量
        </button>
      </div>
    </fieldset>
  );
}
