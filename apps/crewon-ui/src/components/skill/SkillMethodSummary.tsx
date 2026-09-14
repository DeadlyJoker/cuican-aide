import type { SkillMethod } from "@crewon/domain/demonstrated-skill";

export function SkillMethodSummary({ method }: { method: SkillMethod }) {
  return (
    <div className="demonstrated-skill-method-summary">
      <h4>{method.name}</h4>
      <p>{method.purpose}</p>
      <h4>方法</h4>
      <ol>
        {method.steps.map((step, index) => (
          <li key={index}>{step}</li>
        ))}
      </ol>
      <h4>变量</h4>
      <ul>
        {method.parameters.map((field) => (
          <li key={field.name}>
            {field.label} ·{" "}
            {field.type === "string"
              ? "文字"
              : field.type === "number"
                ? "数字"
                : "是 / 否"}
            {field.required ? " · 必填" : " · 选填"}
            {field.enum ? ` · ${field.enum.join("、")}` : ""}
          </li>
        ))}
      </ul>
      <h4>依赖工具</h4>
      <p>{method.requiredToolRefs.join("、") || "无"}</p>
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
      <h4>运行时授权与准备</h4>
      <ul>
        {method.runtimeRequirements.map((text) => (
          <li key={text}>{text}</li>
        ))}
      </ul>
    </div>
  );
}
