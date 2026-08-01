import type { JsonValue } from "@crewon-protocol/serde_json/JsonValue";

import type { LibraryAccent, LibraryItem } from "../domain/crewonDomain";
import type { Locale } from "../i18n";

export type CapabilityLocation = "cloud" | "local";

export type CapabilityPreset =
  | {
      id: string;
      kind: "skill";
      title: string;
      titleEn: string;
      description: string;
      descriptionEn: string;
      category: string;
      glyph: string;
      location: CapabilityLocation;
      logo: string;
      accent: LibraryAccent;
      workflow: string;
    }
  | {
      id: string;
      kind: "mcp";
      title: string;
      titleEn: string;
      description: string;
      descriptionEn: string;
      category: string;
      glyph: string;
      location: CapabilityLocation;
      logo: string;
      accent: LibraryAccent;
      config: Record<string, JsonValue>;
      sourceUrl: string;
    };

export type CapabilityEditorDraft =
  | {
      kind: "skill";
      name: string;
      description: string;
      workflow: string;
    }
  | {
      kind: "mcp";
      name: string;
      presetId: string;
      values: Record<string, string>;
    };

export type CapabilityEditorSaveResult = {
  authorizationUrl?: string;
  kind: "mcp" | "skill";
  name: string;
};

export type CapabilityEditorSaveHandler = (
  draft: CapabilityEditorDraft,
) =>
  | CapabilityEditorSaveResult
  | Promise<CapabilityEditorSaveResult | void>
  | void;

export type McpPresetField = {
  id: string;
  label: string;
  placeholder: string;
  required: boolean;
  type: "password" | "path" | "text";
};

export type McpPresetSetup = {
  connectable: boolean;
  fields: McpPresetField[];
  note: string;
  oauth: boolean;
};

const MCP_OAUTH_PRESET_IDS = new Set(["figma", "github", "notion", "sentry"]);
const MCP_ENDPOINT_TOKEN_SUFFIX = "_MCP_URL";

function mcpPresets(): Extract<CapabilityPreset, { kind: "mcp" }>[] {
  return CAPABILITY_PRESETS.filter(
    (preset): preset is Extract<CapabilityPreset, { kind: "mcp" }> =>
      preset.kind === "mcp",
  );
}

function mcpConfigTokens(config: Record<string, JsonValue>): string[] {
  return [
    ...new Set(
      JSON.stringify(config)
        .match(/<([A-Z0-9_]+)>/g)
        ?.map((token) => token.slice(1, -1)) ?? [],
    ),
  ];
}

function mcpFieldLabel(token: string): string {
  const labels: Record<string, string> = {
    ALLOWED_DIRECTORY: "允许访问的目录",
    REPOSITORY_PATH: "Git 仓库目录",
    YOUR_BRAVE_API_KEY: "Brave API Key",
    IMAP_HOST: "IMAP 服务器",
    SMTP_HOST: "SMTP 服务器",
    MAIL_USERNAME: "邮箱账号",
    MAIL_PASSWORD: "邮箱密码或授权码",
  };
  return (
    labels[token] ??
    token
      .replace(/^YOUR_/, "")
      .split("_")
      .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
      .join(" ")
  );
}

function mcpFieldType(token: string): McpPresetField["type"] {
  if (/(TOKEN|SECRET|PASSWORD|KEY|AUTH_CODE)/.test(token)) {
    return "password";
  }
  if (/(DIRECTORY|PATH)/.test(token)) {
    return "path";
  }
  return "text";
}

export function mcpCapabilityPresets(): Extract<
  CapabilityPreset,
  { kind: "mcp" }
>[] {
  return orderedCapabilityPresets().filter(
    (preset): preset is Extract<CapabilityPreset, { kind: "mcp" }> =>
      preset.kind === "mcp",
  );
}

export function mcpPresetSetup(presetId: string): McpPresetSetup {
  const preset = mcpPresets().find((item) => item.id === presetId);
  if (!preset) {
    throw new Error(`未知服务模板：${presetId}`);
  }
  const tokens = mcpConfigTokens(preset.config);
  const hasManagedEndpoint = tokens.some((token) =>
    token.endsWith(MCP_ENDPOINT_TOKEN_SUFFIX),
  );
  const fields = tokens
    .filter((token) => !token.endsWith(MCP_ENDPOINT_TOKEN_SUFFIX))
    .map((token) => ({
      id: token,
      label: mcpFieldLabel(token),
      placeholder:
        mcpFieldType(token) === "path" ? "/Users/name/project" : "请输入",
      required: true,
      type: mcpFieldType(token),
    }));
  const oauth = MCP_OAUTH_PRESET_IDS.has(preset.id);
  return {
    connectable: !hasManagedEndpoint,
    fields,
    oauth,
    note: hasManagedEndpoint
      ? "该服务没有公开 MCP Server 地址，必须由组织服务目录下发；CrewON 不允许手工填写或猜测 URL。"
      : oauth
        ? "服务地址由 CrewON 内置。保存后会自动打开官方登录页完成 OAuth 授权。"
        : fields.length > 0
          ? "服务地址和启动方式由 CrewON 内置，无需填写 MCP Server URL；只需填写下面的授权或本地范围信息。"
          : "服务地址和启动方式由 CrewON 内置，无需填写 MCP Server URL。",
  };
}

export function mcpEditorDraftForPreset(
  presetId: string,
): Extract<CapabilityEditorDraft, { kind: "mcp" }> {
  const preset = mcpPresets().find((item) => item.id === presetId);
  if (!preset) {
    throw new Error(`未知服务模板：${presetId}`);
  }
  return {
    kind: "mcp",
    name: preset.id,
    presetId: preset.id,
    values: Object.fromEntries(
      mcpPresetSetup(preset.id).fields.map((field) => [field.id, ""]),
    ),
  };
}

function fillMcpConfigValue(
  value: JsonValue,
  values: Record<string, string>,
): JsonValue {
  if (typeof value === "string") {
    return value.replace(/<([A-Z0-9_]+)>/g, (_match, token: string) => {
      const fieldValue = values[token]?.trim();
      if (!fieldValue) {
        throw new Error(`请填写${mcpFieldLabel(token)}`);
      }
      return fieldValue;
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => fillMcpConfigValue(item, values));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter((entry): entry is [string, JsonValue] => entry[1] !== undefined)
        .map(([key, item]) => [key, fillMcpConfigValue(item, values)]),
    );
  }
  return value;
}

export function mcpConfigForEditorDraft(
  draft: Extract<CapabilityEditorDraft, { kind: "mcp" }>,
): { config: Record<string, JsonValue>; oauth: boolean } {
  const preset = mcpPresets().find((item) => item.id === draft.presetId);
  if (!preset) {
    throw new Error(`未知服务模板：${draft.presetId}`);
  }
  const setup = mcpPresetSetup(preset.id);
  if (!setup.connectable) {
    throw new Error(setup.note);
  }
  const config = fillMcpConfigValue(preset.config, draft.values);
  if (!config || Array.isArray(config) || typeof config !== "object") {
    throw new Error("服务模板生成了无效配置");
  }
  return { config: { ...config, enabled: true }, oauth: setup.oauth };
}

const skill = (
  id: string,
  title: string,
  titleEn: string,
  description: string,
  descriptionEn: string,
  category: string,
  glyph: string,
  accent: LibraryAccent,
  workflow: string,
  location: CapabilityLocation = "local",
  logo = "skill",
): CapabilityPreset => ({
  id,
  kind: "skill",
  title,
  titleEn,
  description,
  descriptionEn,
  category,
  glyph,
  location,
  logo,
  accent,
  workflow,
});

const mcp = (
  id: string,
  title: string,
  titleEn: string,
  description: string,
  descriptionEn: string,
  category: string,
  glyph: string,
  accent: LibraryAccent,
  config: Record<string, JsonValue>,
  sourceUrl: string,
  location: CapabilityLocation = "local",
  logo = "mcp",
): CapabilityPreset => ({
  id,
  kind: "mcp",
  title,
  titleEn,
  description,
  descriptionEn,
  category,
  glyph,
  location,
  logo,
  accent,
  config,
  sourceUrl,
});

const remoteEnterpriseMcpConfig = (
  endpointPlaceholder: string,
  env: Record<string, string> = {},
): Record<string, JsonValue> => ({
  command: "npx",
  args: ["-y", "mcp-remote", `<${endpointPlaceholder}>`],
  env,
  enabled: true,
});

export const CAPABILITY_PRESETS: CapabilityPreset[] = [
  skill(
    "document-to-markdown",
    "MarkItDown 文档转换",
    "MarkItDown document conversion",
    "把 PDF、Word、PPT、图片 OCR 和网页整理为结构化 Markdown。",
    "Convert PDFs, Word, slides, OCR images, and web pages into structured Markdown.",
    "内容创作",
    "M",
    "amber",
    "- 识别输入格式与目标结构。\n- 保留标题、表格、链接、脚注和来源。\n- 标注无法可靠识别的内容并输出校验清单。",
    "local",
    "markitdown",
  ),
  skill(
    "spreadsheet-analysis",
    "表格分析",
    "Spreadsheet analysis",
    "创建、清洗和分析 Excel/CSV，输出公式、图表和结论。",
    "Create, clean, and analyze Excel or CSV files with formulas, charts, and findings.",
    "数据分析",
    "X",
    "green",
    "- 先检查表结构、字段类型和缺失值。\n- 使用可追溯公式完成分析并保留原始数据。\n- 输出关键结论、异常点和验证方法。",
    "local",
    "excel",
  ),
  skill(
    "word-document-writer",
    "Word 文档生成",
    "Word document writer",
    "生成可交付的 Word 文档，包含目录、样式、表格和页眉页脚。",
    "Produce delivery-ready Word documents with styles, tables, headers, and pagination.",
    "内容创作",
    "W",
    "blue",
    "- 确认受众、用途和篇幅。\n- 先搭建结构，再填充证据和正文。\n- 渲染检查分页、表格、目录与视觉一致性。",
    "local",
    "word",
  ),
  skill(
    "presentation-builder",
    "PPT 演示文稿",
    "Presentation builder",
    "把资料转成有叙事结构、可直接汇报的演示文稿。",
    "Turn source material into a narrative, presentation-ready slide deck.",
    "内容创作",
    "P",
    "rose",
    "- 明确汇报目标、听众和时长。\n- 设计结论先行的故事线与逐页信息层级。\n- 检查版式、数据来源和演讲节奏。",
    "local",
    "powerpoint",
  ),
  skill(
    "mail-operator",
    "邮件处理",
    "Mail operator",
    "读取、归类、总结邮件并生成回复草稿和跟进清单。",
    "Read, triage, summarize, and draft email replies with follow-up actions.",
    "办公协同",
    "@",
    "amber",
    "- 先按紧急度、主题和发件人归类。\n- 提炼事实、请求、截止时间和责任人。\n- 外发内容只生成草稿，发送前要求确认。",
    "cloud",
    "mail",
  ),
  skill(
    "meeting-assistant",
    "会议助手",
    "Meeting assistant",
    "准备议程、会前材料、会议纪要和行动项。",
    "Prepare agendas, pre-reads, minutes, decisions, and action items.",
    "办公协同",
    "会",
    "violet",
    "- 汇总参会人、目标、上下文和待决策项。\n- 生成时间盒议程与会前阅读材料。\n- 会后记录结论、负责人、截止时间和未决问题。",
    "cloud",
    "meeting",
  ),
  skill(
    "knowledge-curator",
    "知识库整理",
    "Knowledge curator",
    "把项目资料沉淀成可检索、可维护的知识条目。",
    "Turn project material into searchable, maintainable knowledge entries.",
    "知识学习",
    "知",
    "cyan",
    "- 去重并区分事实、决策、假设与过期内容。\n- 为条目补充标签、适用范围、来源和维护人。\n- 建立更新建议和冲突信息清单。",
    "cloud",
    "knowledge",
  ),
  skill(
    "web-research",
    "网页调研",
    "Web research",
    "基于多来源网页进行检索、交叉验证和带引用总结。",
    "Research the web, cross-check sources, and produce citation-ready summaries.",
    "信息资讯",
    "⌕",
    "blue",
    "- 优先使用官方和一手来源。\n- 区分已验证事实、官方宣称和推断。\n- 输出来源链接、时间范围、分歧与未验证边界。",
    "cloud",
    "research",
  ),
  skill(
    "financial-research",
    "金融研究",
    "Financial research",
    "整理公司、行业、基金和宏观信息，形成研究框架。",
    "Structure company, sector, fund, and macro research into an evidence-based brief.",
    "投资理财",
    "¥",
    "rose",
    "- 明确标的、市场、时间范围和数据口径。\n- 分离行情事实、基本面、事件驱动和观点。\n- 标注数据日期、来源、风险与非投资建议边界。",
    "cloud",
    "finance",
  ),
  skill(
    "news-digest",
    "新闻简报",
    "News digest",
    "聚合热点、去重事件并生成按重要性排序的简报。",
    "Aggregate news, deduplicate events, and rank a concise digest by importance.",
    "信息资讯",
    "新",
    "rose",
    "- 按事件而不是文章去重。\n- 比较发布时间与实际发生时间。\n- 输出影响、相关方、后续观察点和来源。",
    "cloud",
    "news",
  ),
  skill(
    "questionnaire-designer",
    "问卷设计",
    "Questionnaire designer",
    "创建问卷结构、题目逻辑、选项和统计口径。",
    "Design survey structure, branching logic, options, and analysis dimensions.",
    "办公协同",
    "问",
    "green",
    "- 明确研究目标、样本和决策用途。\n- 避免诱导、双重问题和选项重叠。\n- 给出跳题逻辑、必答设置和分析维度。",
    "cloud",
    "survey",
  ),
  skill(
    "map-travel-planner",
    "地图与行程规划",
    "Map and travel planner",
    "结合地点、时间和约束生成路线、行程与备选方案。",
    "Build routes and itineraries from locations, time windows, and constraints.",
    "生活服务",
    "⌖",
    "cyan",
    "- 收集起终点、时间、交通方式和偏好。\n- 核对营业时间、距离与关键约束。\n- 输出主方案、备选路线和需实时确认的事项。",
    "cloud",
    "map",
  ),
  skill(
    "book-writer",
    "fbs-bookwriter 长文写作",
    "fbs-bookwriter long-form writing",
    "规划目录、章节和素材，持续生成一致的长篇内容。",
    "Plan outlines, chapters, and sources for coherent long-form writing.",
    "内容创作",
    "书",
    "violet",
    "- 建立读者、主题、语气和事实边界。\n- 维护目录、术语表、人物或论点索引。\n- 分章写作并检查重复、前后矛盾和引用。",
    "local",
    "book",
  ),
  skill(
    "skill-authoring-guide",
    "技能创建指南",
    "Skill authoring guide",
    "创建和维护结构清晰、可执行、可验证的自定义技能。",
    "Create maintainable custom Skills with clear triggers, steps, and verification.",
    "开发工具",
    "技",
    "amber",
    "- 定义触发条件、输入、产物和非目标。\n- 把流程写成可执行步骤并复用现有脚本与模板。\n- 加入验证、失败处理和安全边界。",
    "local",
    "authoring",
  ),
  skill(
    "release-manager",
    "发布与 CI 助手",
    "Release and CI assistant",
    "分析构建、测试和发布状态，生成修复与交付清单。",
    "Analyze build, test, and release state into an actionable delivery checklist.",
    "开发工具",
    "CI",
    "green",
    "- 读取变更范围、测试结果和流水线日志。\n- 区分代码失败、环境失败和偶发失败。\n- 输出修复优先级、验证命令和发布风险。",
    "local",
    "ci",
  ),
  skill(
    "tencent-weiyun-manager",
    "腾讯微云文件管理",
    "Tencent Weiyun file manager",
    "管理微云文件的列表、上传、下载、删除、移动和分享。",
    "List, upload, download, move, delete, and share Tencent Weiyun files.",
    "办公协同",
    "云",
    "blue",
    "- 确认目标目录和文件范围。\n- 写操作先展示影响清单和冲突处理方式。\n- 完成后返回文件路径、分享状态和失败项。",
    "cloud",
    "tencent-cloud",
  ),
  skill(
    "tencent-questionnaire-operator",
    "腾讯问卷操作",
    "Tencent Questionnaire operator",
    "创建、修改和分析腾讯问卷，支持题目逻辑与回收统计。",
    "Create, edit, and analyze Tencent Questionnaire surveys and response logic.",
    "办公协同",
    "问",
    "green",
    "- 明确调研目标、样本和回收期限。\n- 配置题型、分支逻辑和必答规则。\n- 汇总回收结果并标注样本偏差。",
    "cloud",
    "tencent-survey",
  ),
  skill(
    "tencent-rumor-checker",
    "鹅厂辟谣助手",
    "Tencent rumor checker",
    "结合公开资料和内部参考，对腾讯相关传闻进行事实核查。",
    "Cross-check Tencent-related claims against public and authorized internal sources.",
    "信息资讯",
    "验",
    "amber",
    "- 拆分可验证的具体主张。\n- 优先查官方公告和一手来源并记录时间。\n- 输出已证实、存疑、错误和仍需内部确认的结论。",
    "cloud",
    "tencent-news",
  ),
  skill(
    "tencent-map-assistant",
    "腾讯地图·地图助手",
    "Tencent Maps assistant",
    "调用地图地点搜索、路线规划和营业信息生成出行方案。",
    "Use Tencent Maps place search, routing, and place details for travel planning.",
    "生活服务",
    "图",
    "cyan",
    "- 收集起终点、时间和交通偏好。\n- 调用地点与路线数据生成主方案。\n- 给出拥堵、营业时间和需实时核对的备选项。",
    "cloud",
    "tencent-map",
  ),
  skill(
    "neodata-financial-search",
    "NeoData 金融搜索服务",
    "NeoData financial search",
    "自然语言查询股票、基金、宏观、外汇和大宗商品数据。",
    "Query equities, funds, macro, FX, and commodity data in natural language.",
    "投资理财",
    "N",
    "violet",
    "- 明确市场、标的、指标和时间范围。\n- 保留原始数据日期与来源口径。\n- 输出对比、异常和非投资建议声明。",
    "cloud",
    "neodata",
  ),
  skill(
    "pingan-securities-news",
    "平安证券资讯查询",
    "Ping An Securities research search",
    "按股票、公司、行业、ETF 或概念检索新闻、快讯和研报。",
    "Search news, alerts, and research by stock, company, sector, ETF, or theme.",
    "投资理财",
    "平",
    "amber",
    "- 确认检索对象与时间区间。\n- 按公告、新闻、研报和市场观点分组。\n- 标注来源、发布时间和潜在利益冲突。",
    "cloud",
    "pingan",
  ),
  skill(
    "tencent-stock-data",
    "腾讯自选股·金融数据查询",
    "Tencent Stock financial data",
    "查询 A 股、港股、美股、指数和 ETF 的行情与基础数据。",
    "Query market and fundamental data for China, Hong Kong, US equities, indices, and ETFs.",
    "投资理财",
    "股",
    "rose",
    "- 明确证券代码、市场和复权口径。\n- 分开展示实时行情、历史数据和基本面。\n- 标注数据时间、延迟和不可用于自动交易的边界。",
    "cloud",
    "tencent-stock",
  ),
  skill(
    "web-access",
    "Web Access 浏览器自动化",
    "Web Access browser automation",
    "通过本地浏览器完成网页访问、登录态操作、表单填写和页面验证。",
    "Use a local browser for signed-in navigation, form actions, and page verification.",
    "效率工具",
    "W",
    "blue",
    "- 复用用户允许的浏览器会话。\n- 写入、发送和删除操作前明确确认。\n- 以页面可见状态和截图完成验收。",
    "local",
    "chrome",
  ),
  skill(
    "qq-music-assistant",
    "QQ 音乐助手",
    "QQ Music assistant",
    "搜索歌曲、歌手、专辑和歌单，生成推荐与音乐信息摘要。",
    "Search songs, artists, albums, and playlists and create music recommendations.",
    "生活服务",
    "乐",
    "green",
    "- 识别场景、偏好、语言和年代。\n- 检索曲目与可用版本并去重。\n- 输出推荐理由、歌单结构和版权可用性提示。",
    "cloud",
    "qq-music",
  ),
  skill(
    "a-share-full-stack-data",
    "A 股全栈数据",
    "A-share full-stack data",
    "查询行情、研报、资金流、公告和财报并生成结构化数据包。",
    "Query prices, research, flows, filings, and financials for A-share analysis.",
    "投资理财",
    "A",
    "slate",
    "- 使用证券代码和交易所唯一定位标的。\n- 按行情、资金、公告、研报和财务拆分数据。\n- 记录来源时间并检查跨来源口径差异。",
    "cloud",
    "chart",
  ),
  skill(
    "qq-browser-automation",
    "QQ 浏览器自动化",
    "QQ Browser automation",
    "面向 QQ 浏览器执行网页导航、登录态操作和批量页面任务。",
    "Automate navigation, signed-in actions, and repeated page tasks in QQ Browser.",
    "效率工具",
    "Q",
    "blue",
    "- 检查浏览器连接和当前登录态。\n- 使用稳定页面元素执行操作。\n- 对提交、下载和外发动作保留确认与结果证据。",
    "local",
    "qq-browser",
  ),
  skill(
    "imap-smtp-mail",
    "IMAP/SMTP 邮件",
    "IMAP/SMTP mail",
    "通过标准 IMAP/SMTP 收取、检索、整理邮件并生成发送草稿。",
    "Read, search, organize, and draft email through standard IMAP and SMTP.",
    "办公协同",
    "邮",
    "rose",
    "- 使用环境变量读取服务器和账号配置。\n- 先检索与生成草稿，不自动发送。\n- 发送前再次展示收件人、主题、附件和正文摘要。",
    "local",
    "mail",
  ),
  skill(
    "tencent-news-search",
    "腾讯新闻",
    "Tencent News",
    "聚焦国内外热点、热榜、早晚报和实时资讯查询。",
    "Search Tencent News for domestic and international trends, rankings, and briefings.",
    "信息资讯",
    "讯",
    "rose",
    "- 明确主题、地区和时间范围。\n- 按事件去重并区分发生时间与发布时间。\n- 输出来源、影响和后续观察点。",
    "cloud",
    "tencent-news",
  ),
  skill(
    "entrepreneurship-learning",
    "创业可以学",
    "Entrepreneurship learning coach",
    "面向创业者和管理者解答商业、管理和组织问题。",
    "Coach founders and managers through business, organization, and management questions.",
    "商业运营",
    "创",
    "amber",
    "- 识别企业阶段、行业和当前约束。\n- 用案例、框架和反例展开分析。\n- 输出可验证的小步实验和复盘指标。",
    "cloud",
    "business",
  ),
  skill(
    "qq-mail-suite",
    "QQ 邮箱",
    "QQ Mail suite",
    "收发、搜索和整理 QQ 邮件，支持附件与线程摘要。",
    "Read, send, search, and organize QQ Mail with attachments and thread summaries.",
    "办公协同",
    "Q",
    "amber",
    "- 使用授权后的 QQ 邮箱连接。\n- 按线程、联系人和紧急度整理。\n- 外发邮件只生成草稿并在发送前确认。",
    "cloud",
    "qq-mail",
  ),
  skill(
    "wecom-suite",
    "企业微信套件",
    "WeCom suite",
    "覆盖企业微信消息、文档、日程、会议、待办和通讯录工作流。",
    "Operate authorized WeCom messaging, docs, calendar, meetings, tasks, and contacts.",
    "办公协同",
    "企",
    "cyan",
    "- 核对企业身份、应用权限和目标组织。\n- 读取操作直接执行，写入与外发先生成草稿。\n- 返回资源 ID、链接、权限状态和失败项。",
    "cloud",
    "wecom",
  ),
  skill(
    "tencent-ima-suite",
    "腾讯 ima 知识库",
    "Tencent ima knowledge suite",
    "读取、写入和检索 ima 笔记与知识库内容。",
    "Read, write, and search Tencent ima notes and knowledge bases.",
    "知识学习",
    "i",
    "green",
    "- 确认目标知识库和授权范围。\n- 检索时保留原文引用和资料链接。\n- 写入时先展示标题、标签、来源和更新范围。",
    "cloud",
    "ima",
  ),
  skill(
    "feishu-suite",
    "飞书套件",
    "Feishu suite",
    "覆盖飞书消息、文档、表格、日历、任务、知识库和审批。",
    "Operate authorized Feishu messages, docs, sheets, calendar, tasks, wiki, and approvals.",
    "办公协同",
    "飞",
    "blue",
    "- 核对租户、应用和用户授权。\n- 按资源类型调用消息、文档、日历和知识库。\n- 对外发、审批和共享变更保留确认。",
    "cloud",
    "feishu",
  ),
  skill(
    "dingtalk-suite",
    "钉钉套件",
    "DingTalk suite",
    "覆盖钉钉消息、文档、日历、待办、通讯录和审批工作流。",
    "Operate authorized DingTalk messages, docs, calendar, tasks, contacts, and approvals.",
    "办公协同",
    "钉",
    "blue",
    "- 检查组织、应用凭证和权限范围。\n- 读取资源时保留原始链接。\n- 发消息、提交审批和修改共享前要求确认。",
    "cloud",
    "dingtalk",
  ),
  skill(
    "tencent-docs-suite",
    "腾讯文档套件",
    "Tencent Docs suite",
    "创建、编辑和协作腾讯在线文档、表格与幻灯片。",
    "Create, edit, and collaborate on Tencent Docs documents, sheets, and slides.",
    "办公协同",
    "文",
    "blue",
    "- 确认文档类型、目标目录和协作者。\n- 读取现有结构后进行最小范围修改。\n- 返回文档链接、权限和变更摘要。",
    "cloud",
    "tencent-docs",
  ),
  skill(
    "tencent-meeting-suite",
    "腾讯会议套件",
    "Tencent Meeting suite",
    "创建、查询和管理腾讯会议、参会人、日程与会议材料。",
    "Create and manage Tencent Meetings, participants, schedules, and meeting materials.",
    "办公协同",
    "会",
    "violet",
    "- 确认时间、时区、参会人和会议权限。\n- 创建前检查日程冲突。\n- 返回会议链接、会议号、参会范围和待办。",
    "cloud",
    "tencent-meeting",
  ),
  skill(
    "tapd-project-assistant",
    "TAPD 项目助手",
    "TAPD project assistant",
    "管理需求、缺陷、任务、迭代、工时和项目进度。",
    "Manage TAPD stories, bugs, tasks, iterations, effort, and project progress.",
    "开发工具",
    "T",
    "amber",
    "- 确认项目、迭代和目标工作项。\n- 查询与汇总可直接执行，状态变更先展示差异。\n- 返回工作项链接、负责人和后续阻塞。",
    "cloud",
    "tapd",
  ),
  skill(
    "cnb-devops-suite",
    "CNB 研发协同",
    "CNB DevOps suite",
    "通过自然语言管理 CNB 仓库、Issue、PR、流水线和制品。",
    "Manage CNB repositories, issues, pull requests, pipelines, and artifacts.",
    "开发工具",
    "C",
    "rose",
    "- 锁定组织、仓库和目标分支。\n- 读取与诊断优先，提交、合并和发布前确认。\n- 返回变更、流水线状态和可回滚信息。",
    "cloud",
    "cnb",
  ),
  skill(
    "wps-docs-suite",
    "金山文档套件",
    "WPS Docs suite",
    "创建、搜索和管理金山文档、表格、PDF 和演示文稿。",
    "Create, search, and manage WPS documents, sheets, PDFs, and presentations.",
    "办公协同",
    "W",
    "violet",
    "- 确认企业、目录和目标文档类型。\n- 读取现有结构后执行编辑。\n- 返回文档链接、共享范围和变更摘要。",
    "cloud",
    "wps",
  ),
  mcp(
    "filesystem",
    "文件系统",
    "Filesystem",
    "受控读取、搜索和修改指定目录中的文件。",
    "Read, search, and modify files inside explicitly allowed directories.",
    "效率工具",
    "文",
    "blue",
    {
      command: "npx",
      args: [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "<ALLOWED_DIRECTORY>",
      ],
      enabled: false,
    },
    "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    "local",
    "filesystem",
  ),
  mcp(
    "memory",
    "长期记忆",
    "Memory",
    "以知识图谱保存实体、关系和观察记录。",
    "Persist entities, relations, and observations in a knowledge graph.",
    "知识学习",
    "忆",
    "violet",
    {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-memory"],
      enabled: false,
    },
    "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
    "local",
    "memory",
  ),
  mcp(
    "git",
    "Git 仓库",
    "Git repository",
    "读取、搜索和操作 Git 仓库。",
    "Read, search, and operate on Git repositories.",
    "开发工具",
    "G",
    "rose",
    {
      command: "uvx",
      args: ["mcp-server-git", "--repository", "<REPOSITORY_PATH>"],
      enabled: false,
    },
    "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
    "local",
    "git",
  ),
  mcp(
    "fetch",
    "网页抓取",
    "Web fetch",
    "抓取网页并转换为适合模型处理的内容。",
    "Fetch web pages and convert them into model-friendly content.",
    "信息资讯",
    "↗",
    "cyan",
    { command: "uvx", args: ["mcp-server-fetch"], enabled: false },
    "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
    "local",
    "web",
  ),
  mcp(
    "time",
    "时间与时区",
    "Time and timezone",
    "查询当前时间并进行时区转换。",
    "Read current time and convert between timezones.",
    "效率工具",
    "时",
    "amber",
    { command: "uvx", args: ["mcp-server-time"], enabled: false },
    "https://github.com/modelcontextprotocol/servers/tree/main/src/time",
    "local",
    "time",
  ),
  mcp(
    "sequential-thinking",
    "结构化思考",
    "Sequential thinking",
    "为复杂任务提供可调整的分步思考工具。",
    "Provide an adjustable step-by-step thinking tool for complex tasks.",
    "效率工具",
    "思",
    "violet",
    {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
      enabled: false,
    },
    "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
    "local",
    "thinking",
  ),
  mcp(
    "playwright",
    "浏览器自动化",
    "Browser automation",
    "通过结构化页面信息执行浏览、点击、输入和测试。",
    "Browse, click, type, and test through structured page accessibility data.",
    "开发工具",
    "◎",
    "blue",
    { command: "npx", args: ["-y", "@playwright/mcp@latest"], enabled: false },
    "https://github.com/microsoft/playwright-mcp",
    "local",
    "browser",
  ),
  mcp(
    "github",
    "GitHub",
    "GitHub",
    "管理仓库、Issue、PR、Actions 和代码搜索。",
    "Manage repositories, issues, pull requests, Actions, and code search.",
    "开发工具",
    "GH",
    "slate",
    {
      url: "https://api.githubcopilot.com/mcp/",
      enabled: true,
    },
    "https://github.com/github/github-mcp-server",
    "cloud",
    "github",
  ),
  mcp(
    "notion",
    "Notion",
    "Notion",
    "搜索、读取和写入 Notion 工作区内容。",
    "Search, read, and write content in a Notion workspace.",
    "办公协同",
    "N",
    "slate",
    { url: "https://mcp.notion.com/mcp", enabled: true },
    "https://developers.notion.com/guides/mcp/overview",
    "cloud",
    "notion",
  ),
  mcp(
    "figma",
    "Figma",
    "Figma",
    "读取设计上下文并连接 Figma 设计工作流。",
    "Read design context and connect to Figma design workflows.",
    "设计创意",
    "F",
    "rose",
    { url: "https://mcp.figma.com/mcp", enabled: true },
    "https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/",
    "cloud",
    "figma",
  ),
  mcp(
    "sentry",
    "Sentry",
    "Sentry",
    "查询错误、事件和项目上下文，辅助故障定位。",
    "Query errors, events, and project context for incident diagnosis.",
    "开发工具",
    "S",
    "rose",
    { url: "https://mcp.sentry.dev/", enabled: true },
    "https://docs.sentry.io/product/sentry-mcp/",
    "cloud",
    "sentry",
  ),
  mcp(
    "brave-search",
    "Brave Search",
    "Brave Search",
    "提供网页、新闻、图片和本地搜索能力。",
    "Provide web, news, image, and local search capabilities.",
    "信息资讯",
    "B",
    "amber",
    {
      command: "npx",
      args: ["-y", "@brave/brave-search-mcp-server", "--transport", "stdio"],
      env: { BRAVE_API_KEY: "<YOUR_BRAVE_API_KEY>" },
      enabled: true,
    },
    "https://github.com/brave/brave-search-mcp-server",
    "cloud",
    "brave",
  ),
  mcp(
    "tongdaxin-market-data",
    "通达信",
    "TongdaXin market data",
    "查询行情、条件选股、研究报告、公告和宏观信息；需要填写可用的通达信 MCP Endpoint。",
    "Query market data, screeners, research, filings, and macro data through an authorized endpoint.",
    "投资理财",
    "通",
    "rose",
    remoteEnterpriseMcpConfig("TONGDAXIN_MCP_URL", {
      TONGDAXIN_TOKEN: "<YOUR_TONGDAXIN_TOKEN>",
    }),
    "https://www.tdx.com.cn/",
    "cloud",
    "chart",
  ),
  mcp(
    "tencent-stock",
    "腾讯自选股",
    "Tencent Stock",
    "获取多市场行情、资金动态、选股和模拟交易能力；需要组织提供的 MCP Endpoint。",
    "Access multi-market quotes, capital flows, screening, and simulated trading through an authorized endpoint.",
    "投资理财",
    "股",
    "rose",
    remoteEnterpriseMcpConfig("TENCENT_STOCK_MCP_URL", {
      TENCENT_STOCK_TOKEN: "<YOUR_TENCENT_STOCK_TOKEN>",
    }),
    "https://stockapp.finance.qq.com/",
    "cloud",
    "tencent-stock",
  ),
  mcp(
    "qq-mail",
    "QQ 邮箱",
    "QQ Mail",
    "收发、搜索和整理 QQ 邮件；支持企业远程 MCP 或自建 IMAP/SMTP 网关。",
    "Read, send, search, and organize QQ Mail through a remote MCP or an IMAP/SMTP gateway.",
    "办公协同",
    "邮",
    "amber",
    remoteEnterpriseMcpConfig("QQ_MAIL_MCP_URL", {
      QQ_MAIL_AUTH_CODE: "<YOUR_QQ_MAIL_AUTH_CODE>",
    }),
    "https://service.mail.qq.com/",
    "cloud",
    "qq-mail",
  ),
  mcp(
    "ima-knowledge",
    "ima 知识库",
    "ima knowledge base",
    "引用、检索和浏览 ima 知识库资料；需要已授权的 ima MCP Endpoint。",
    "Reference, search, and browse ima knowledge bases through an authorized endpoint.",
    "知识学习",
    "i",
    "green",
    remoteEnterpriseMcpConfig("IMA_MCP_URL", {
      IMA_ACCESS_TOKEN: "<YOUR_IMA_ACCESS_TOKEN>",
    }),
    "https://ima.qq.com/",
    "cloud",
    "ima",
  ),
  mcp(
    "lexiang-knowledge",
    "乐享知识库",
    "Lexiang knowledge base",
    "搜索、创建和管理乐享知识库文档，支持 Markdown 导入和标签整理。",
    "Search, create, and manage Lexiang knowledge documents with Markdown import and tagging.",
    "知识学习",
    "享",
    "blue",
    remoteEnterpriseMcpConfig("LEXIANG_MCP_URL", {
      LEXIANG_ACCESS_TOKEN: "<YOUR_LEXIANG_ACCESS_TOKEN>",
    }),
    "https://github.com/modelcontextprotocol/specification",
    "cloud",
    "knowledge",
  ),
  mcp(
    "tencent-docs",
    "腾讯文档",
    "Tencent Docs",
    "创建、编辑和协作腾讯在线文档、表格与幻灯片。",
    "Create, edit, and collaborate on Tencent Docs documents, sheets, and slides.",
    "办公协同",
    "文",
    "blue",
    remoteEnterpriseMcpConfig("TENCENT_DOCS_MCP_URL", {
      TENCENT_DOCS_ACCESS_TOKEN: "<YOUR_TENCENT_DOCS_ACCESS_TOKEN>",
    }),
    "https://docs.qq.com/open/",
    "cloud",
    "tencent-docs",
  ),
  mcp(
    "tencent-meeting",
    "腾讯会议",
    "Tencent Meeting",
    "创建、查询和管理腾讯会议、参会人和日程。",
    "Create, query, and manage Tencent Meetings, participants, and schedules.",
    "办公协同",
    "会",
    "violet",
    remoteEnterpriseMcpConfig("TENCENT_MEETING_MCP_URL", {
      TENCENT_MEETING_SECRET: "<YOUR_TENCENT_MEETING_SECRET>",
    }),
    "https://meeting.tencent.com/open-api.html",
    "cloud",
    "tencent-meeting",
  ),
  mcp(
    "wecom",
    "企业微信",
    "WeCom",
    "连接企业微信消息、文档、日程、会议、待办和通讯录能力。",
    "Connect authorized WeCom messages, docs, calendar, meetings, tasks, and contacts.",
    "办公协同",
    "企",
    "cyan",
    remoteEnterpriseMcpConfig("WECOM_MCP_URL", {
      WECOM_CORP_ID: "<YOUR_WECOM_CORP_ID>",
      WECOM_CORP_SECRET: "<YOUR_WECOM_CORP_SECRET>",
    }),
    "https://developer.work.weixin.qq.com/document/",
    "cloud",
    "wecom",
  ),
  mcp(
    "feishu",
    "飞书",
    "Feishu",
    "连接飞书消息、文档、表格、日历、任务、知识库和审批。",
    "Connect authorized Feishu messages, docs, sheets, calendar, tasks, wiki, and approvals.",
    "办公协同",
    "飞",
    "blue",
    remoteEnterpriseMcpConfig("FEISHU_MCP_URL", {
      FEISHU_APP_ID: "<YOUR_FEISHU_APP_ID>",
      FEISHU_APP_SECRET: "<YOUR_FEISHU_APP_SECRET>",
    }),
    "https://open.feishu.cn/document/",
    "cloud",
    "feishu",
  ),
  mcp(
    "dingtalk",
    "钉钉",
    "DingTalk",
    "连接钉钉消息、文档、日历、待办、通讯录和审批。",
    "Connect authorized DingTalk messages, docs, calendar, tasks, contacts, and approvals.",
    "办公协同",
    "钉",
    "blue",
    remoteEnterpriseMcpConfig("DINGTALK_MCP_URL", {
      DINGTALK_CLIENT_ID: "<YOUR_DINGTALK_CLIENT_ID>",
      DINGTALK_CLIENT_SECRET: "<YOUR_DINGTALK_CLIENT_SECRET>",
    }),
    "https://open.dingtalk.com/document/",
    "cloud",
    "dingtalk",
  ),
  mcp(
    "tencent-questionnaire",
    "腾讯问卷",
    "Tencent Questionnaire",
    "创建、管理和分析腾讯问卷，支持回收统计和题目逻辑。",
    "Create, manage, and analyze Tencent Questionnaire surveys and response logic.",
    "办公协同",
    "问",
    "green",
    remoteEnterpriseMcpConfig("TENCENT_QUESTIONNAIRE_MCP_URL", {
      TENCENT_QUESTIONNAIRE_TOKEN: "<YOUR_TENCENT_QUESTIONNAIRE_TOKEN>",
    }),
    "https://wj.qq.com/",
    "cloud",
    "tencent-survey",
  ),
  mcp(
    "tapd",
    "TAPD",
    "TAPD",
    "查询和管理需求、缺陷、任务、迭代、工时和项目状态。",
    "Query and manage stories, bugs, tasks, iterations, effort, and project status.",
    "开发工具",
    "T",
    "amber",
    remoteEnterpriseMcpConfig("TAPD_MCP_URL", {
      TAPD_API_USER: "<YOUR_TAPD_API_USER>",
      TAPD_API_PASSWORD: "<YOUR_TAPD_API_PASSWORD>",
    }),
    "https://open.tapd.cn/document/api-doc/",
    "cloud",
    "tapd",
  ),
  mcp(
    "cnb",
    "CNB",
    "CNB",
    "管理 CNB 仓库、Issue、PR、流水线、制品库和代码搜索。",
    "Manage CNB repositories, issues, pull requests, pipelines, artifacts, and code search.",
    "开发工具",
    "C",
    "rose",
    remoteEnterpriseMcpConfig("CNB_MCP_URL", {
      CNB_TOKEN: "<YOUR_CNB_TOKEN>",
    }),
    "https://cnb.cool/",
    "cloud",
    "cnb",
  ),
  mcp(
    "tencent-weiyun",
    "腾讯微云",
    "Tencent Weiyun",
    "查看、上传、下载、删除微云文件并生成分享链接。",
    "List, upload, download, delete, and share Tencent Weiyun files.",
    "办公协同",
    "云",
    "blue",
    remoteEnterpriseMcpConfig("TENCENT_WEIYUN_MCP_URL", {
      TENCENT_WEIYUN_TOKEN: "<YOUR_TENCENT_WEIYUN_TOKEN>",
    }),
    "https://www.weiyun.com/",
    "cloud",
    "tencent-cloud",
  ),
  mcp(
    "fubang-assistant",
    "福帮手",
    "Fu assistant",
    "面向组织身份、场景包查询、首信、状态确认和人工交接的协同连接器。",
    "An enterprise collaboration connector for identity, scenario packs, status, and human handoff.",
    "办公协同",
    "福",
    "blue",
    remoteEnterpriseMcpConfig("FUBANG_MCP_URL", {
      FUBANG_ACCESS_TOKEN: "<YOUR_FUBANG_ACCESS_TOKEN>",
    }),
    "https://github.com/modelcontextprotocol/specification",
    "cloud",
    "assistant",
  ),
  mcp(
    "wps-docs",
    "金山文档",
    "WPS Docs",
    "创建、搜索和管理金山文档、表格、PDF、演示文稿和智能文档。",
    "Create, search, and manage WPS documents, sheets, PDFs, presentations, and smart docs.",
    "办公协同",
    "W",
    "violet",
    remoteEnterpriseMcpConfig("WPS_MCP_URL", {
      WPS_APP_ID: "<YOUR_WPS_APP_ID>",
      WPS_APP_SECRET: "<YOUR_WPS_APP_SECRET>",
    }),
    "https://open.wps.cn/",
    "cloud",
    "wps",
  ),
  mcp(
    "imap-smtp",
    "IMAP/SMTP 邮件",
    "IMAP/SMTP mail",
    "通过自建 MCP 网关连接标准 IMAP/SMTP 邮箱，支持多账户和附件。",
    "Connect standard IMAP/SMTP mailboxes through a self-hosted MCP gateway.",
    "办公协同",
    "邮",
    "rose",
    remoteEnterpriseMcpConfig("MAIL_MCP_URL", {
      IMAP_HOST: "<YOUR_IMAP_HOST>",
      SMTP_HOST: "<YOUR_SMTP_HOST>",
      MAIL_USERNAME: "<YOUR_MAIL_USERNAME>",
      MAIL_PASSWORD: "<YOUR_MAIL_PASSWORD>",
    }),
    "https://datatracker.ietf.org/doc/html/rfc3501",
    "cloud",
    "mail",
  ),
  mcp(
    "tencent-map",
    "腾讯地图",
    "Tencent Maps",
    "地点搜索、地理编码、路线规划、距离计算和周边检索。",
    "Place search, geocoding, routing, distance calculation, and nearby discovery.",
    "生活服务",
    "图",
    "cyan",
    remoteEnterpriseMcpConfig("TENCENT_MAP_MCP_URL", {
      TENCENT_MAP_KEY: "<YOUR_TENCENT_MAP_KEY>",
    }),
    "https://lbs.qq.com/service/webService/webServiceGuide/webServiceOverview",
    "cloud",
    "tencent-map",
  ),
  mcp(
    "tencent-news",
    "腾讯新闻",
    "Tencent News",
    "搜索热点、热榜、早晚报和实时新闻资讯。",
    "Search trending topics, rankings, briefings, and real-time Tencent News.",
    "信息资讯",
    "讯",
    "rose",
    remoteEnterpriseMcpConfig("TENCENT_NEWS_MCP_URL", {
      TENCENT_NEWS_TOKEN: "<YOUR_TENCENT_NEWS_TOKEN>",
    }),
    "https://news.qq.com/",
    "cloud",
    "tencent-news",
  ),
  mcp(
    "qq-music",
    "QQ 音乐",
    "QQ Music",
    "搜索歌曲、歌手、专辑、歌词和歌单，支持推荐场景。",
    "Search songs, artists, albums, lyrics, and playlists for recommendation workflows.",
    "生活服务",
    "乐",
    "green",
    remoteEnterpriseMcpConfig("QQ_MUSIC_MCP_URL", {
      QQ_MUSIC_TOKEN: "<YOUR_QQ_MUSIC_TOKEN>",
    }),
    "https://y.qq.com/",
    "cloud",
    "qq-music",
  ),
];

const FEATURED_PRESET_IDS = [
  "tencent-weiyun-manager",
  "tencent-questionnaire-operator",
  "tencent-rumor-checker",
  "tencent-map-assistant",
  "neodata-financial-search",
  "document-to-markdown",
  "pingan-securities-news",
  "tencent-stock-data",
  "web-access",
  "qq-music-assistant",
  "spreadsheet-analysis",
  "skill-authoring-guide",
  "tongdaxin-market-data",
  "tencent-stock",
  "qq-mail",
  "ima-knowledge",
  "lexiang-knowledge",
  "tencent-docs",
  "tencent-meeting",
  "wecom",
  "feishu",
  "dingtalk",
  "tencent-questionnaire",
  "tapd",
  "cnb",
  "tencent-weiyun",
  "fubang-assistant",
  "wps-docs",
] as const;

export function orderedCapabilityPresets(): CapabilityPreset[] {
  const featuredOrder = new Map<string, number>(
    FEATURED_PRESET_IDS.map((presetId, index) => [presetId, index]),
  );
  return CAPABILITY_PRESETS.map((preset, sourceIndex) => ({
    preset,
    rank: featuredOrder.get(preset.id),
    sourceIndex,
  }))
    .sort((left, right) => {
      if (left.preset.kind !== right.preset.kind) {
        return left.preset.kind === "skill" ? -1 : 1;
      }
      const leftRank = left.rank ?? Number.MAX_SAFE_INTEGER;
      const rightRank = right.rank ?? Number.MAX_SAFE_INTEGER;
      return leftRank - rightRank || left.sourceIndex - right.sourceIndex;
    })
    .map(({ preset }) => preset);
}

export function capabilityPresetById(
  presetId: string,
  presetKind: CapabilityPreset["kind"],
): CapabilityPreset | null {
  return (
    CAPABILITY_PRESETS.find(
      (preset) => preset.id === presetId && preset.kind === presetKind,
    ) ?? null
  );
}

export function capabilityPresetItems(locale: Locale): LibraryItem[] {
  return orderedCapabilityPresets().map((preset) => ({
    title: locale === "zh" ? preset.title : preset.titleEn,
    meta:
      locale === "zh"
        ? preset.kind === "mcp"
          ? "服务"
          : "技能"
        : preset.kind === "mcp"
          ? "MCP"
          : "Skill",
    description: locale === "zh" ? preset.description : preset.descriptionEn,
    glyph: preset.glyph,
    logo: preset.logo,
    accent: preset.accent,
    badge: {
      label: locale === "zh" ? "可添加" : "Add",
      tone: "idle",
    },
    tags: [
      preset.location === "local"
        ? locale === "zh"
          ? "本地"
          : "Local"
        : locale === "zh"
          ? "云端"
          : "Cloud",
      locale === "zh"
        ? preset.kind === "mcp"
          ? "服务"
          : "技能"
        : preset.kind === "mcp"
          ? "MCP"
          : "Skill",
      preset.category,
    ],
    capabilityKind: preset.kind,
    capabilityLocation: preset.location,
    catalog: true,
    action: {
      type: "capability-preset",
      presetId: preset.id,
      presetKind: preset.kind,
    },
  }));
}
