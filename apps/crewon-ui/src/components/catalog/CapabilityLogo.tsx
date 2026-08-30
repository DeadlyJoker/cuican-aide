import type { CSSProperties, ReactNode } from "react";

type LogoShape =
  | "browser"
  | "chart"
  | "chat"
  | "cloud"
  | "cnb"
  | "document"
  | "feishu"
  | "figma"
  | "folder"
  | "git"
  | "mail"
  | "map"
  | "meeting"
  | "music"
  | "network"
  | "panda"
  | "search"
  | "shield"
  | "survey"
  | "tapd"
  | "thinking";

type LogoDefinition = {
  background: string;
  color: string;
  shape?: LogoShape;
  text?: string;
};

const LOGOS: Record<string, LogoDefinition> = {
  skill: { background: "#eef2ff", color: "#4f46e5", text: "✦" },
  mcp: { background: "#eff6ff", color: "#2563eb", shape: "network" },
  markitdown: { background: "#fff7ed", color: "#c2410c", text: "M" },
  excel: { background: "#e9f7ef", color: "#107c41", text: "X" },
  word: { background: "#eaf2ff", color: "#185abd", text: "W" },
  powerpoint: { background: "#fff0eb", color: "#c43e1c", text: "P" },
  mail: { background: "#fff8db", color: "#c69200", shape: "mail" },
  meeting: { background: "#eef2ff", color: "#5266d6", shape: "meeting" },
  knowledge: { background: "#eefbf6", color: "#0f8b6d", shape: "folder" },
  research: { background: "#edf6ff", color: "#1976d2", shape: "search" },
  finance: { background: "#fff2ed", color: "#c2410c", shape: "chart" },
  news: { background: "#fff1f2", color: "#d9485f", text: "新" },
  survey: { background: "#ecfdf5", color: "#16a167", shape: "survey" },
  map: { background: "#eefcf8", color: "#009f84", shape: "map" },
  book: { background: "#f6f0ff", color: "#7c3aed", text: "书" },
  authoring: { background: "#fff4e8", color: "#d16618", text: "技" },
  ci: { background: "#edfdf3", color: "#18864b", text: "CI" },
  "tencent-cloud": { background: "#eef4ff", color: "#3d6df2", shape: "cloud" },
  "tencent-survey": { background: "#effcf7", color: "#26b77a", shape: "survey" },
  "tencent-map": { background: "#eef7ff", color: "#2f7cf6", shape: "map" },
  "tencent-stock": { background: "#fff2ed", color: "#d64025", shape: "chart" },
  "tencent-news": { background: "#fff2f3", color: "#e3404f", text: "讯" },
  "tencent-docs": { background: "#eef2ff", color: "#4c62e8", shape: "document" },
  "tencent-meeting": { background: "#eef2ff", color: "#5b6cf0", shape: "meeting" },
  "qq-music": { background: "#effbea", color: "#61a915", shape: "music" },
  "qq-mail": { background: "#fff7d8", color: "#d3a400", shape: "mail" },
  "qq-browser": { background: "#eef3ff", color: "#4f6ff5", shape: "browser" },
  qq: { background: "#eef4ff", color: "#293d9b", text: "QQ" },
  wecom: { background: "#edf7ff", color: "#2f7ff5", shape: "chat" },
  feishu: { background: "#eef8ff", color: "#3370ff", shape: "feishu" },
  dingtalk: { background: "#edf6ff", color: "#1677ff", text: "⚡" },
  ima: { background: "#effbf2", color: "#111827", shape: "panda" },
  tapd: { background: "#fff7ed", color: "#e97715", shape: "tapd" },
  cnb: { background: "#fff3ed", color: "#ef6c35", shape: "cnb" },
  wps: { background: "#f2f0ff", color: "#6254e8", text: "WPS" },
  neodata: { background: "#eef2ff", color: "#5c6ce7", text: "N" },
  pingan: { background: "#fff4ea", color: "#d87526", text: "平安" },
  chrome: { background: "#eef5ff", color: "#4285f4", shape: "browser" },
  github: { background: "#f3f4f6", color: "#181717", text: "GH" },
  notion: { background: "#f5f5f5", color: "#111111", text: "N" },
  figma: { background: "#fff2ed", color: "#f24e1e", shape: "figma" },
  sentry: { background: "#f3f0f8", color: "#362d59", text: "S" },
  brave: { background: "#fff1ed", color: "#fb542b", shape: "shield" },
  git: { background: "#fff1ed", color: "#f03c2e", shape: "git" },
  filesystem: { background: "#eef5ff", color: "#3978d4", shape: "folder" },
  memory: { background: "#f4efff", color: "#7c3aed", shape: "thinking" },
  web: { background: "#eefbff", color: "#1787a8", text: "↗" },
  time: { background: "#fff8e8", color: "#ba7a10", text: "时" },
  thinking: { background: "#f4efff", color: "#7156cc", shape: "thinking" },
  browser: { background: "#eef4ff", color: "#3667e8", shape: "browser" },
  developer: { background: "#edfdf4", color: "#168653", text: "</>" },
  assistant: { background: "#f2f5ff", color: "#5368e5", text: "AI" },
  business: { background: "#fff7ed", color: "#c46a16", text: "商" },
  chart: { background: "#fff1ed", color: "#d9482f", shape: "chart" },
  message: { background: "#eef7ff", color: "#3677d4", shape: "chat" },
};

function LogoShape({ shape }: { shape: LogoShape }): ReactNode {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: 1.8,
  };
  switch (shape) {
    case "browser":
      return <><circle cx="12" cy="12" r="8.5" {...common} /><circle cx="12" cy="12" r="3" {...common} /><path d="M12 3.5 17 12M4.7 8h9.8M8 19.5l4-7.5" {...common} /></>;
    case "chart":
      return <><path d="M5 17V7M5 15l4-4 3 2 6-7" {...common} /><path d="M15 6h3v3" {...common} /></>;
    case "chat":
      return <><path d="M4 6.5h12v8H9l-4 3v-3H4z" {...common} /><path d="M10 9.5h10v7h-3v2.5l-3.5-2.5H10" {...common} /></>;
    case "cloud":
      return <path d="M7.5 17.5h9.2a4 4 0 0 0 .1-8 5.3 5.3 0 0 0-10-1.2A4.6 4.6 0 0 0 7.5 17.5Z" {...common} />;
    case "cnb":
      return <><path d="M12 4c3 0 4.5 2.5 3 5-2.5 0-4.5-2-3-5Z" fill="currentColor" opacity=".85" /><path d="M19 12c0 3-2.5 4.5-5 3 0-2.5 2-4.5 5-3Z" fill="currentColor" opacity=".65" /><path d="M12 20c-3 0-4.5-2.5-3-5 2.5 0 4.5 2 3 5Z" fill="currentColor" opacity=".45" /><path d="M5 12c0-3 2.5-4.5 5-3 0 2.5-2 4.5-5 3Z" fill="currentColor" /></>;
    case "document":
      return <><path d="M7 3.5h7l3 3v14H7z" {...common} /><path d="M14 3.5v4h3M9.5 11h5M9.5 14h5M9.5 17h3.5" {...common} /></>;
    case "feishu":
      return <><path d="m6 7 5 5-3 3-5-5z" fill="currentColor" opacity=".9" /><path d="m13 4 5 5-5 5-3-3z" fill="#00d6b9" /><path d="m13 14 4-4 4 4-4 4z" fill="#7b61ff" /></>;
    case "figma":
      return <><circle cx="9" cy="6" r="3" fill="#f24e1e" /><circle cx="15" cy="6" r="3" fill="#ff7262" /><circle cx="9" cy="12" r="3" fill="#a259ff" /><circle cx="15" cy="12" r="3" fill="#1abcfe" /><circle cx="9" cy="18" r="3" fill="#0acf83" /></>;
    case "folder":
      return <path d="M4 7h6l2 2h8v9H4z" {...common} />;
    case "git":
      return <><path d="m12 3 9 9-9 9-9-9z" {...common} /><circle cx="9" cy="9" r="1.3" fill="currentColor" /><circle cx="15" cy="15" r="1.3" fill="currentColor" /><path d="M9 10.5v3l6 1.5" {...common} /></>;
    case "mail":
      return <><rect x="4" y="6" width="16" height="12" rx="2" {...common} /><path d="m5 8 7 5 7-5" {...common} /></>;
    case "map":
      return <><path d="M12 20s6-5.4 6-10a6 6 0 1 0-12 0c0 4.6 6 10 6 10Z" {...common} /><circle cx="12" cy="10" r="2" {...common} /></>;
    case "meeting":
      return <><rect x="4" y="7" width="11" height="10" rx="2" {...common} /><path d="m15 10 5-3v10l-5-3" {...common} /></>;
    case "music":
      return <><path d="M10 18V6l8-2v11" {...common} /><circle cx="7.5" cy="18" r="2.5" {...common} /><circle cx="15.5" cy="15" r="2.5" {...common} /></>;
    case "network":
      return <><circle cx="12" cy="5" r="2" {...common} /><circle cx="6" cy="17" r="2" {...common} /><circle cx="18" cy="17" r="2" {...common} /><path d="m11 7-4 8M13 7l4 8M8 17h8" {...common} /></>;
    case "panda":
      return <><circle cx="8" cy="7" r="3" fill="currentColor" /><circle cx="16" cy="7" r="3" fill="currentColor" /><circle cx="12" cy="12" r="7" fill="white" stroke="currentColor" strokeWidth="1.5" /><ellipse cx="9" cy="11" rx="1.5" ry="2" fill="currentColor" /><ellipse cx="15" cy="11" rx="1.5" ry="2" fill="currentColor" /><path d="M10 15c1.2 1 2.8 1 4 0" {...common} /></>;
    case "search":
      return <><circle cx="10.5" cy="10.5" r="6" {...common} /><path d="m15 15 4.5 4.5" {...common} /></>;
    case "shield":
      return <path d="m12 3 7 3v5c0 4.8-3 8-7 10-4-2-7-5.2-7-10V6z" {...common} />;
    case "survey":
      return <><path d="M7 4h10v16H7z" {...common} /><path d="m9 9 1.5 1.5L14 7M9 15h6" {...common} /></>;
    case "tapd":
      return <><rect x="4" y="4" width="6" height="6" rx="1.5" fill="#f26b38" /><rect x="14" y="4" width="6" height="6" rx="1.5" fill="#f5b623" /><rect x="4" y="14" width="6" height="6" rx="1.5" fill="#50b7e8" /><rect x="14" y="14" width="6" height="6" rx="1.5" fill="#6cc04a" /></>;
    case "thinking":
      return <><path d="M8 16c-2-1-3-3-3-5.5A6.5 6.5 0 0 1 17.6 8M16 8c2 1.2 3 3.2 3 5.5A6.5 6.5 0 0 1 6.4 16" {...common} /><circle cx="12" cy="12" r="2" {...common} /></>;
  }
}

export function CapabilityLogo({
  fallback,
  logo,
}: {
  fallback: string;
  logo?: string;
}) {
  const definition = LOGOS[logo ?? ""] ?? {
    ...LOGOS.skill,
    text: fallback,
  };
  return (
    <span
      className="capability-brand-logo"
      data-logo={logo ?? "fallback"}
      style={{
        "--capability-logo-bg": definition.background,
        "--capability-logo-color": definition.color,
      } as CSSProperties}
    >
      {definition.shape ? (
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <LogoShape shape={definition.shape} />
        </svg>
      ) : (
        definition.text || fallback
      )}
    </span>
  );
}
