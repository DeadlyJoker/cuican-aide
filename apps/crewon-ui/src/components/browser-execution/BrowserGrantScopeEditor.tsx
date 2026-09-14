import type {
  BrowserGrantRule,
  BrowserGrantScope,
} from "../../lib/browser-execution/browserExecutionGrant";

export const browserControlLabels: Record<string, string> = {
  "button": "按钮",
  "textbox": "输入框",
  "combobox": "下拉框",
  "link": "链接",
  "checkbox": "复选框",
  "radio": "单选框",
  "tab": "标签页",
  "menuitem": "菜单项",
  "option": "选项",
  "spinbutton": "数字输入框",
  "": "日期等原生控件（无角色）",
};

export const browserActionLabels: Record<BrowserGrantRule["action"], string> = {
  navigate: "打开页面",
  click: "点击",
  fill: "填写",
  select: "选择",
  download: "下载文件",
};

function newRule(action: BrowserGrantRule["action"]): BrowserGrantRule {
  if (action === "navigate") return { action, urlTemplate: "" };
  return {
    action,
    target: {
      role:
        action === "fill"
          ? "textbox"
          : action === "select"
            ? "combobox"
            : "button",
      name: "",
    },
    ...(["fill", "select"].includes(action) ? { value: { literal: "" } } : {}),
  };
}

export function BrowserGrantScopeEditor({
  value,
  parameterNames,
  onChange,
}: {
  value: BrowserGrantScope;
  parameterNames?: readonly string[];
  onChange: (scope: BrowserGrantScope) => void;
}) {
  const updateRule = (index: number, rule: BrowserGrantRule) =>
    onChange({
      ...value,
      rules: value.rules.map((item, i) => (i === index ? rule : item)),
    });
  return (
    <div className="browser-grant-editor">
      <p>
        填写本次允许使用的网站与操作，再点击下方授权。控件名称须与网页一致；修改配置后需重新授权。
      </p>
      <fieldset>
        <legend>允许的网站（最多 8 个）</legend>
        <p>
          填写完整网站来源，例如
          https://reports.example.com；不要附带路径或末尾斜杠。
        </p>
        {value.origins.map((origin, index) => (
          <div className="browser-grant-editor-row" key={index}>
            <label>
              网站 {index + 1}
              <input
                type="url"
                value={origin}
                placeholder="https://reports.example.com"
                onChange={(event) =>
                  onChange({
                    ...value,
                    origins: value.origins.map((item, i) =>
                      i === index ? event.target.value : item,
                    ),
                  })
                }
              />
            </label>
            <button
              type="button"
              aria-label={`删除网站 ${index + 1}`}
              onClick={() =>
                onChange({
                  ...value,
                  origins: value.origins.filter((_, i) => i !== index),
                })
              }
            >
              删除
            </button>
          </div>
        ))}
        <button
          type="button"
          disabled={value.origins.length >= 8}
          onClick={() =>
            onChange({ ...value, origins: [...value.origins, ""] })
          }
        >
          添加网站
        </button>
      </fieldset>
      <fieldset>
        <legend>允许的操作（最多 32 项）</legend>
        {value.rules.map((rule, index) => (
          <fieldset className="browser-grant-editor-rule" key={index}>
            <legend>操作 {index + 1}</legend>
            <label>
              操作类型
              <select
                value={rule.action}
                onChange={(event) =>
                  updateRule(
                    index,
                    newRule(event.target.value as BrowserGrantRule["action"]),
                  )
                }
              >
                {Object.entries(browserActionLabels).map(([action, label]) => (
                  <option key={action} value={action}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {rule.action === "navigate" ? (
              <label>
                页面地址模板
                <input
                  maxLength={2048}
                  value={rule.urlTemplate ?? ""}
                  placeholder="https://reports.example.com/export?date={date}"
                  onChange={(event) =>
                    updateRule(index, {
                      ...rule,
                      urlTemplate: event.target.value,
                    })
                  }
                />
                <span>
                  地址必须属于允许的网站。可用 {"{参数名}"} 替换日期等输入。
                </span>
                {parameterNames && (
                  <span>
                    可用参数：
                    {parameterNames.length ? parameterNames.join("、") : "无"}
                  </span>
                )}
              </label>
            ) : (
              <>
                <label>
                  控件类型
                  <select
                    value={rule.target?.role ?? "button"}
                    onChange={(event) =>
                      updateRule(index, {
                        ...rule,
                        target: {
                          name: rule.target?.name ?? "",
                          role: event.target.value,
                        },
                      })
                    }
                  >
                    {Object.entries(browserControlLabels).map(
                      ([role, label]) => (
                        <option key={role} value={role}>
                          {label}
                        </option>
                      ),
                    )}
                  </select>
                </label>
                <label>
                  控件名称
                  <input
                    maxLength={120}
                    value={rule.target?.name ?? ""}
                    placeholder="例如：导出 CSV"
                    onChange={(event) =>
                      updateRule(index, {
                        ...rule,
                        target: {
                          role: rule.target?.role ?? "button",
                          name: event.target.value,
                        },
                      })
                    }
                  />
                </label>
                {(rule.action === "fill" || rule.action === "select") && (
                  <>
                    <label>
                      填写内容来源
                      <select
                        value={
                          rule.value && "parameter" in rule.value
                            ? "parameter"
                            : "literal"
                        }
                        onChange={(event) =>
                          updateRule(index, {
                            ...rule,
                            value:
                              event.target.value === "parameter"
                                ? { parameter: "" }
                                : { literal: "" },
                          })
                        }
                      >
                        <option value="literal">固定值</option>
                        <option
                          value="parameter"
                          disabled={parameterNames?.length === 0}
                        >
                          任务参数
                        </option>
                      </select>
                    </label>
                    {rule.value && "parameter" in rule.value ? (
                      <label>
                        参数名称
                        {parameterNames ? (
                          <select
                            value={rule.value.parameter}
                            onChange={(event) =>
                              updateRule(index, {
                                ...rule,
                                value: { parameter: event.target.value },
                              })
                            }
                          >
                            <option value="">选择参数</option>
                            {parameterNames.map((name) => (
                              <option key={name} value={name}>
                                {name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            maxLength={512}
                            value={rule.value.parameter}
                            onChange={(event) =>
                              updateRule(index, {
                                ...rule,
                                value: { parameter: event.target.value },
                              })
                            }
                          />
                        )}
                      </label>
                    ) : (
                      <label>
                        固定值（可留空）
                        <input
                          maxLength={512}
                          value={
                            rule.value && "literal" in rule.value
                              ? rule.value.literal
                              : ""
                          }
                          onChange={(event) =>
                            updateRule(index, {
                              ...rule,
                              value: { literal: event.target.value },
                            })
                          }
                        />
                      </label>
                    )}
                  </>
                )}
              </>
            )}
            <button
              type="button"
              onClick={() =>
                onChange({
                  ...value,
                  rules: value.rules.filter((_, i) => i !== index),
                })
              }
            >
              删除操作 {index + 1}
            </button>
          </fieldset>
        ))}
        <button
          type="button"
          disabled={value.rules.length >= 32}
          onClick={() =>
            onChange({ ...value, rules: [...value.rules, newRule("click")] })
          }
        >
          添加操作
        </button>
      </fieldset>
    </div>
  );
}
