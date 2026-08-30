import type {
  CapabilityPanel,
  CapabilityPanelAction,
  CapabilityPanelField,
  CapabilityPanelRow,
} from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";
import {
  settingsSectionDescription,
  settingsSectionLabel,
  type SettingsSection,
} from "./settingsCatalog";

type FieldCopy = { description?: string; label: string };

const fieldCopy: Record<Locale, Record<string, FieldCopy>> = {
  zh: {
    "appearance-accent": {
      description: "用于按钮和重点内容",
      label: "重点颜色",
    },
    "appearance-background": { label: "页面颜色" },
    "appearance-code-font": { label: "任务内容字体" },
    "appearance-code-font-size": {
      description: "调整任务内容的文字大小",
      label: "任务内容字号",
    },
    "appearance-contrast": {
      description: "让次要文字更容易阅读",
      label: "文字对比",
    },
    "appearance-diff-markers": {
      description: "选择如何显示内容改动",
      label: "修改标记",
    },
    "appearance-font-smoothing": {
      description: "让文字边缘更清晰",
      label: "文字清晰度",
    },
    "appearance-foreground": { label: "文字颜色" },
    "appearance-ui-font": { label: "界面字体" },
    "appearance-ui-font-size": {
      description: "调整界面文字大小",
      label: "界面字号",
    },
    "config-model": {
      description: "新任务默认使用的模型",
      label: "默认模型",
    },
    "config-approval-policy": {
      description: "决定助理在执行可能产生影响的操作前何时向你确认",
      label: "需要确认的时机",
    },
    "config-sandbox-mode": {
      description: "限制助理可以查看和修改的内容",
      label: "可操作范围",
    },
    "model-provider-api-key": {
      description: "只保存在当前设备的安全存储中",
      label: "访问密钥",
    },
    "model-provider-base-url": {
      description: "由模型服务提供；选择常用来源时会自动填写",
      label: "服务地址",
    },
    "model-provider-credential-kind": {
      description: "选择这个模型需要的登录方式",
      label: "登录方式",
    },
    "model-provider-env-key": {
      description: "选择“从设备读取”时填写",
      label: "设备凭证名称",
    },
    "model-provider-id": {
      description: "用于区分多个模型来源，仅当前设备可见",
      label: "简称",
    },
    "model-provider-model-id": {
      description: "填写要在任务中使用的具体模型",
      label: "模型名称",
    },
    "model-provider-name": {
      description: "显示在模型选择列表中的名称",
      label: "显示名称",
    },
    "model-provider-selected": { label: "设为默认模型" },
    "model-provider-vendor": {
      description: "选择常用模型来源，也可以添加其他来源",
      label: "模型来源",
    },
    "personalization-developer-instructions": {
      description: "约定助理的语气、做事原则和需要避免的行为",
      label: "表达与原则",
    },
    "personalization-instructions": {
      description: "告诉助理它是谁、主要帮助你完成什么工作",
      label: "助理角色",
    },
    "personalization-memory-mode": {
      description: "选择助理是否从对话中学习，并在需要时使用记忆",
      label: "长期记忆",
    },
    "remote-control-revoke-client": {
      description: "移除后，该设备需要重新添加才能继续使用",
      label: "选择设备",
    },
  },
  en: {
    "appearance-accent": {
      description: "Used for buttons and highlighted content",
      label: "Highlight color",
    },
    "appearance-background": { label: "Page color" },
    "appearance-code-font": { label: "Task content font" },
    "appearance-code-font-size": {
      description: "Adjust text size in task content",
      label: "Task content size",
    },
    "appearance-contrast": {
      description: "Make secondary text easier to read",
      label: "Text contrast",
    },
    "appearance-diff-markers": {
      description: "Choose how content changes are shown",
      label: "Change markers",
    },
    "appearance-font-smoothing": {
      description: "Make text edges look clearer",
      label: "Text clarity",
    },
    "appearance-foreground": { label: "Text color" },
    "appearance-ui-font": { label: "Interface font" },
    "appearance-ui-font-size": {
      description: "Adjust the size of interface text",
      label: "Interface text size",
    },
    "config-model": {
      description: "The model used for new tasks",
      label: "Default model",
    },
    "config-approval-policy": {
      description: "Choose when the assistant asks before an impactful action",
      label: "When to ask",
    },
    "config-sandbox-mode": {
      description: "Limit what the assistant may view and change",
      label: "Access range",
    },
    "model-provider-api-key": {
      description: "Stored securely on this device only",
      label: "Access key",
    },
    "model-provider-base-url": {
      description:
        "Provided by the model service and filled for common choices",
      label: "Service address",
    },
    "model-provider-credential-kind": {
      description: "Choose how this model is accessed",
      label: "Sign-in method",
    },
    "model-provider-env-key": {
      description: "Used when “Read from device” is selected",
      label: "Device credential name",
    },
    "model-provider-id": {
      description: "Distinguishes multiple model sources on this device",
      label: "Short name",
    },
    "model-provider-model-id": {
      description: "The specific model to use for tasks",
      label: "Model name",
    },
    "model-provider-name": {
      description: "The name shown in model pickers",
      label: "Display name",
    },
    "model-provider-selected": { label: "Make this the default model" },
    "model-provider-vendor": {
      description: "Choose a common model source or add another one",
      label: "Model source",
    },
    "personalization-developer-instructions": {
      description:
        "Set the assistant’s tone, working principles, and boundaries",
      label: "Style & principles",
    },
    "personalization-instructions": {
      description: "Tell the assistant who it is and what it should help with",
      label: "Assistant role",
    },
    "personalization-memory-mode": {
      description:
        "Choose whether the assistant learns from and recalls conversations",
      label: "Long-term memory",
    },
    "remote-control-revoke-client": {
      description: "The device must be added again after removal",
      label: "Choose a device",
    },
  },
};

export function presentSettingsPanel(
  section: SettingsSection,
  panel: CapabilityPanel | null,
  locale: Locale,
): CapabilityPanel | null {
  if (panel === null) return null;
  const fields = panel.fields?.map((field) => presentField(field, locale));
  const rows = panel.rows?.map((row) => presentRow(section, row, locale));
  const hasStructuredContent = Boolean(fields?.length || rows?.length);
  const modelStatus =
    section === "model-providers" && rows?.length && panel.body
      ? panel.body
          .split("\n")
          .find((line) => /^(?:运行状态|Runtime)\s*[:：]/iu.test(line.trim()))
      : undefined;
  const deviceSummary =
    section === "computer-control" && panel.body
      ? presentBody(section, panel.body, locale)
      : undefined;

  return {
    ...panel,
    title: settingsSectionLabel(section, locale),
    subtitle: settingsSectionDescription(section, locale),
    body: modelStatus
      ? [
          productText(modelStatus, locale),
          locale === "zh"
            ? "访问密钥只保存在当前设备。"
            : "Access keys stay on this device.",
        ].join("\n")
      : deviceSummary
        ? deviceSummary
        : panel.body && !hasStructuredContent
          ? presentBody(section, panel.body, locale)
          : undefined,
    error: panel.error ? presentError(section, panel.error, locale) : undefined,
    fields,
    rows,
    actions: panel.actions?.map((action) => presentAction(action, locale)),
  };
}

function presentField(
  field: CapabilityPanelField,
  locale: Locale,
): CapabilityPanelField {
  const copy = fieldCopy[locale][field.id];
  return {
    ...field,
    label: copy?.label ?? productText(field.label, locale),
    description:
      copy?.description ??
      (field.description ? productText(field.description, locale) : undefined),
    options: field.options?.map((option) => ({
      ...option,
      label: optionLabel(field.id, option.label, option.value, locale),
    })),
    unit: field.id.startsWith("appearance-") ? undefined : field.unit,
  };
}

function optionLabel(
  fieldId: string,
  label: string,
  value: string,
  locale: Locale,
): string {
  if (fieldId === "config-approval-policy") {
    const labels =
      locale === "zh"
        ? {
            "never": "无需确认",
            "on-failure": "执行遇到问题时",
            "on-request": "助理判断需要时",
            "untrusted": "执行外部操作时",
          }
        : {
            "never": "Never ask",
            "on-failure": "When an action runs into trouble",
            "on-request": "When the assistant decides it is needed",
            "untrusted": "Before outside actions",
          };
    return labels[value as keyof typeof labels] ?? productText(label, locale);
  }
  if (fieldId === "config-sandbox-mode") {
    const labels =
      locale === "zh"
        ? {
            "danger-full-access": "整台设备",
            "read-only": "仅查看",
            "workspace-write": "当前项目",
          }
        : {
            "danger-full-access": "This device",
            "read-only": "View only",
            "workspace-write": "Current project",
          };
    return labels[value as keyof typeof labels] ?? productText(label, locale);
  }
  if (fieldId === "model-provider-credential-kind") {
    const labels =
      locale === "zh"
        ? {
            "bearer-token": "保存在当前设备",
            "env-key": "从设备读取",
            "none": "无需登录",
          }
        : {
            "bearer-token": "Save on this device",
            "env-key": "Read from device",
            "none": "No sign-in needed",
          };
    return labels[value as keyof typeof labels] ?? productText(label, locale);
  }
  if (fieldId === "appearance-diff-markers") {
    const labels =
      locale === "zh"
        ? { color: "颜色", sign: "符号" }
        : { color: "Color", sign: "Symbols" };
    return labels[value as keyof typeof labels] ?? productText(label, locale);
  }
  return productText(label.split(" — ")[0] ?? label, locale);
}

function presentRow(
  section: SettingsSection,
  row: CapabilityPanelRow,
  locale: Locale,
): CapabilityPanelRow {
  const subtitle =
    section === "model-providers" && /^https?:\/\//iu.test(row.subtitle ?? "")
      ? undefined
      : row.subtitle
        ? productText(row.subtitle, locale)
        : undefined;
  const meta = row.meta
    ?.filter((item) => !/^https?:\/\//iu.test(item))
    .map((item) => productText(item, locale))
    .filter(Boolean);
  return {
    ...row,
    title: productText(row.title, locale),
    subtitle,
    meta,
    badge: row.badge ? productText(row.badge, locale) : undefined,
    actions: row.actions?.map((action) => presentAction(action, locale)),
  };
}

function presentAction(
  action: CapabilityPanelAction,
  locale: Locale,
): CapabilityPanelAction {
  const id = action.id;
  const label = (() => {
    if (/refresh|retry/iu.test(id)) return locale === "zh" ? "刷新" : "Refresh";
    if (/reload/iu.test(id)) return locale === "zh" ? "重新连接" : "Reconnect";
    if (/:(?:test)$|provider-test/iu.test(id))
      return locale === "zh" ? "检查连接" : "Check connection";
    if (/:(?:edit)$|provider-edit/iu.test(id))
      return locale === "zh" ? "编辑" : "Edit";
    if (/:(?:select)$|set-default/iu.test(id))
      return locale === "zh" ? "使用" : "Use";
    if (/:(?:delete)$|delete|remove|revoke/iu.test(id))
      return locale === "zh" ? "移除" : "Remove";
    if (/model-provider-add/iu.test(id))
      return locale === "zh" ? "添加模型" : "Add model";
    if (/start-remote-pairing/iu.test(id))
      return locale === "zh" ? "添加设备" : "Add device";
    if (/enable-remote-control/iu.test(id))
      return locale === "zh" ? "开启设备协助" : "Turn on device assistance";
    if (/disable-remote-control/iu.test(id))
      return locale === "zh" ? "关闭设备协助" : "Turn off device assistance";
    if (/login-chatgpt/iu.test(id))
      return locale === "zh" ? "登录模型账号" : "Sign in to model account";
    if (/login-device-code/iu.test(id))
      return locale === "zh" ? "使用登录代码" : "Use a sign-in code";
    if (/logout/iu.test(id)) return locale === "zh" ? "退出登录" : "Sign out";
    if (/save/iu.test(id)) return locale === "zh" ? "保存" : "Save";
    if (/cancel/iu.test(id)) return locale === "zh" ? "取消" : "Cancel";
    if (/setup-windows-sandbox/iu.test(id))
      return locale === "zh" ? "开启设备保护" : "Turn on device protection";
    return productText(action.label, locale);
  })();
  return { ...action, label };
}

function presentBody(
  section: SettingsSection,
  body: string,
  locale: Locale,
): string {
  if (section === "model-providers") {
    const outcome = body
      .split(/\n\s*\n/u)
      .filter((paragraph) => !/^(说明|Notes)/iu.test(paragraph.trim()))
      .map((paragraph) =>
        paragraph
          .split("\n")
          .filter((line) => !internalDetailLine(line))
          .map((line) => productText(line, locale))
          .join("\n"),
      )
      .filter(Boolean);
    outcome.push(
      locale === "zh"
        ? "访问密钥只保存在当前设备。切换模型不会中断正在进行的任务。"
        : "Access keys stay on this device. Switching models will not interrupt a running task.",
    );
    return outcome.join("\n\n");
  }

  let hidesConnectionErrors = false;
  const lines = body
    .split("\n")
    .filter((line) => {
      if (
        section === "connections" &&
        /部分连接读取失败|Some connection reads failed/iu.test(line)
      ) {
        hidesConnectionErrors = true;
        return true;
      }
      return !(hidesConnectionErrors && /^\s*[-*]\s+/u.test(line));
    })
    .filter((line) => !internalDetailLine(line))
    .map((line) => productText(line, locale).trimEnd())
    .filter((line, index, all) => line || (index > 0 && all[index - 1]));
  return lines.join("\n").trim();
}

function internalDetailLine(line: string): boolean {
  const trimmed = line.trim().replace(/^[-*]\s+/u, "");
  if (!trimmed) return false;
  return (
    /^(?:id|loginId|clientId|installation ID|environment ID|name|version|website|channel|labels|install|plugins?|catalog revision|namespaceTools|imageGeneration|webSearch)\s*:/iu.test(
      trimmed,
    ) ||
    /^(?:server|服务|client list error|设备读取错误|type|platform|os|app)\s*:/iu.test(
      trimmed,
    ) ||
    /(?:config\.toml|mcp_servers|SQLite|CSRF|\bJSON\b|\bDNS\b)/iu.test(
      trimmed,
    ) ||
    /^[a-z][a-z0-9]*(?:_[a-z0-9]+){2,}$/u.test(trimmed)
  );
}

function presentError(
  section: SettingsSection,
  error: string,
  locale: Locale,
): string {
  const normalized = error.toLowerCase();
  if (/session|login|sign.?in|登录|会话/iu.test(normalized)) {
    return locale === "zh"
      ? "登录状态已失效，请重新登录后再试。"
      : "Your sign-in has expired. Sign in again and retry.";
  }
  if (/credential|api.?key|密钥|凭据/iu.test(normalized)) {
    return locale === "zh"
      ? "访问凭证不可用，请检查后再试。"
      : "The access credential is unavailable. Check it and retry.";
  }
  const subject = settingsSectionLabel(section, locale);
  return locale === "zh"
    ? `${subject}暂时不可用，请稍后重试。`
    : `${subject} is temporarily unavailable. Try again shortly.`;
}

export function productText(value: string, locale: Locale): string {
  const replacements: Array<[RegExp, string]> =
    locale === "zh"
      ? [
          [/Runtime environment/giu, "安全与权限"],
          [/运行环境/gu, "安全与权限"],
          [/运行状态/gu, "连接状态"],
          [/Windows sandbox implementations?/giu, "Windows 设备保护方式"],
          [/Windows sandbox status/giu, "Windows 设备保护"],
          [/Windows sandbox error/giu, "Windows 设备保护提示"],
          [/Windows 沙箱实现/gu, "Windows 设备保护方式"],
          [/Windows 沙箱状态/gu, "Windows 设备保护"],
          [/Windows 沙箱错误/gu, "Windows 设备保护提示"],
          [/Provider Control API/giu, "模型服务"],
          [/Control API/giu, "对话服务"],
          [/Control runtime/giu, "当前服务"],
          [/app-server/giu, "本地服务"],
          [/MCP servers?/giu, "工具与服务"],
          [/MCP 服务器/giu, "工具与服务"],
          [/MCP/gu, "工具"],
          [/Provider/giu, "模型服务"],
          [/Responses API/giu, "模型服务"],
          [/Responses/giu, "模型连接"],
          [/Computer control/giu, "设备协助"],
          [/电脑操控/gu, "设备协助"],
          [/Remote control/giu, "设备协助"],
          [/远程控制/gu, "设备协助"],
          [/Paired clients/giu, "已添加设备"],
          [/已配对设备/gu, "已添加设备"],
          [/lastSeen/giu, "最近使用"],
          [/Base URL/giu, "服务地址"],
          [/\bURL\b/gu, "服务地址"],
          [/\bAPI Key\b/giu, "访问密钥"],
          [/\bAPI\b/gu, "服务"],
          [/endpoint/giu, "服务地址"],
          [/runtime/giu, "当前状态"],
          [/运行态/gu, "当前"],
          [/运行时/gu, "当前服务"],
          [/认证状态/gu, "登录状态"],
          [/认证方式/gu, "登录方式"],
          [/Auth method/giu, "登录方式"],
          [/Provider capabilities/giu, "可用能力"],
          [/模型供应商能力/gu, "可用能力"],
          [/Provider 能力/gu, "可用能力"],
          [/命名空间工具/gu, "扩展工具"],
          [/Permission profiles?/giu, "权限方案"],
          [/权限档案/gu, "权限方案"],
          [/catalog/giu, "列表"],
          [/config(?:uration)?/giu, "设置"],
          [/配置层/gu, "设置来源"],
          [/Sandbox modes?/giu, "可操作范围"],
          [/沙箱模式/gu, "可操作范围"],
          [/沙箱/gu, "设备保护"],
          [/Plugin marketplaces?/giu, "扩展来源"],
          [/Marketplaces?/giu, "扩展来源"],
          [/插件市场/gu, "扩展来源"],
          [/插件/gu, "扩展"],
          [/应用连接器/gu, "网页应用"],
          [/App connectors?/giu, "网页应用"],
          [/Feature requirements?/giu, "其他限制"],
          [/特性要求/gu, "其他限制"],
          [/Web search modes?/giu, "联网查询"],
          [/网页搜索模式/gu, "联网查询"],
          [/Locked computer use/giu, "锁屏时允许协助"],
          [/锁屏电脑控制/gu, "锁屏时允许协助"],
          [/Residency/giu, "数据存放要求"],
          [/数据驻留/gu, "数据存放要求"],
          [/\bWorker\b/gu, "任务服务"],
          [/鉴权|认证/gu, "授权"],
          [/credential/giu, "访问凭证"],
          [/token/giu, "登录凭证"],
          [/environment variable/giu, "设备凭证"],
          [/环境变量/gu, "设备凭证"],
          [/系统密钥库凭据（状态未公开）/gu, "已保存在当前设备"],
          [/系统密钥库/gu, "当前设备"],
          [/\bunknown\b/giu, "暂不可用"],
          [/\byes\b/giu, "是"],
          [/\bno\b/giu, "否"],
          [/read-only/giu, "仅查看"],
          [/workspace-write/giu, "当前项目"],
          [/danger-full-access/giu, "整台设备"],
          [/\bunelevated\b/giu, "标准保护"],
          [/\belevated\b/giu, "增强保护"],
          [/\bconnected\b/giu, "已连接"],
          [/\bconnecting\b/giu, "正在连接"],
          [/\bdisabled\b/giu, "已关闭"],
          [/\benabled\b/giu, "已开启"],
          [/\blive\b/giu, "联网获取"],
          [/\bcached\b/giu, "已有内容"],
          [/\bTokens?\b/giu, "用量"],
          [/\bGit\b/giu, "代码版本"],
          [/\bworktrees?\b/giu, "并行任务"],
          [/工作树/gu, "并行任务"],
          [/\bHooks?\b/giu, "自动执行"],
          [/钩子/gu, "自动执行"],
          [/\bstored\b/giu, "已保存"],
        ]
      : [
          [/Runtime environment/giu, "Safety & access"],
          [/\bRuntime\s*:/giu, "Connection status:"],
          [/Computer control/giu, "Device assistance"],
          [/Remote control/giu, "Device assistance"],
          [/Paired clients/giu, "Added devices"],
          [/lastSeen/giu, "Last used"],
          [/Provider Control API/giu, "model service"],
          [/Control API/giu, "conversation service"],
          [/Control runtime/giu, "current service"],
          [/app-server/giu, "local service"],
          [/MCP servers?/giu, "tools and services"],
          [/MCP/gu, "tool"],
          [/Provider/giu, "model service"],
          [/Responses API/giu, "model service"],
          [/Responses/giu, "model connection"],
          [/Base URL/giu, "service address"],
          [/\bURL\b/gu, "service address"],
          [/\bAPI Key\b/giu, "access key"],
          [/\bAPI\b/gu, "service"],
          [/endpoint/giu, "service address"],
          [/runtime/giu, "current status"],
          [/catalog/giu, "list"],
          [/config(?:uration)?/giu, "settings"],
          [/sandbox modes?/giu, "access range"],
          [/sandbox/giu, "device protection"],
          [/plugin marketplaces?/giu, "extension sources"],
          [/plugins?/giu, "extensions"],
          [/app connectors?/giu, "web apps"],
          [/\bWorker\b/gu, "task service"],
          [/authentication|auth/giu, "authorization"],
          [/credentials?/giu, "access details"],
          [/token/giu, "sign-in credential"],
          [/environment variable/giu, "device credential"],
          [
            /OS credential \(availability not exposed\)/giu,
            "Saved on this device",
          ],
          [/\bunknown\b/giu, "unavailable"],
          [/read-only/giu, "view only"],
          [/workspace-write/giu, "current project"],
          [/danger-full-access/giu, "this device"],
        ];

  let result = value.replace(/\s*·\s*[a-z][a-z0-9_:-]{5,}\s*$/gimu, "");
  for (const [pattern, replacement] of replacements) {
    result = result.replace(pattern, replacement);
  }
  return result
    .replace(/OpenAI\s+服务/giu, "OpenAI")
    .replace(/LiteLLM Gateway/giu, "LiteLLM")
    .replace(
      locale === "zh"
        ? /其他限制\s*[:：].+/gu
        : /Feature requirements\s*:.+/giu,
      locale === "zh" ? "其他限制：已按组织要求开启" : "Additional limits: On",
    )
    .replace(
      /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/giu,
      locale === "zh" ? "已设置" : "configured",
    )
    .replace(/[^\S\r\n]{2,}/gu, " ")
    .trim();
}
