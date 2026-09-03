import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy, Maximize2, X } from "lucide-react";

type MarkdownSegment =
  | { type: "markdown"; text: string }
  | { type: "code"; code: string; complete: boolean; language: string | null };

export type MarkdownMention = Readonly<{
  displayText: string;
  id: string;
}>;

type RenderMarkdownOptions = Readonly<{
  mentions?: readonly MarkdownMention[];
  streaming?: boolean;
}>;

type MarkdownAstNode = {
  children?: MarkdownAstNode[];
  type: string;
  url?: string;
  value?: string;
};

const MARKDOWN_MENTION_FRAGMENT_PREFIX = "#crewon-member/";
const markdownMentionSkippedNodeTypes = new Set([
  "code",
  "definition",
  "html",
  "inlineCode",
  "link",
  "linkReference",
]);

export type MermaidColorScheme = "dark" | "light";

type MermaidState =
  | { code: ""; status: "idle"; svg: null }
  | {
      code: string;
      colorScheme: MermaidColorScheme;
      status: "loading";
      svg: string | null;
    }
  | {
      code: string;
      colorScheme: MermaidColorScheme;
      status: "holding";
      svg: string | null;
    }
  | {
      code: string;
      colorScheme: MermaidColorScheme;
      status: "rendered";
      svg: string;
    }
  | {
      code: string;
      colorScheme: MermaidColorScheme;
      message: string;
      status: "error";
      svg: null;
    };

export type MermaidDisplayState = "error" | "live" | "loading" | "rendered";

const MERMAID_LIVE_RENDER_INTERVAL_MS = 220;
const MERMAID_RENDER_CACHE_LIMIT = 24;
let mermaidInitializedScheme: MermaidColorScheme | null = null;

type CachedMermaidSvg = Readonly<{
  elementId: string;
  svg: string;
}>;

type MermaidRenderRequest = Readonly<{
  code: string;
  colorScheme: MermaidColorScheme;
  elementId: string;
  reject: (reason: unknown) => void;
  resolve: (svg: string) => void;
  slotId: string;
}>;

const mermaidRenderCache = new Map<string, CachedMermaidSvg>();
const mermaidRenderQueue = new Map<string, MermaidRenderRequest>();
const mermaidRenderOrder: string[] = [];
let mermaidRenderQueueRunning = false;

class MermaidRenderSupersededError extends Error {
  constructor() {
    super("Mermaid render superseded by newer source.");
  }
}

function hashDiagramId(code: string): string {
  let hash = 0;
  for (let index = 0; index < code.length; index += 1) {
    hash = Math.imul(31, hash) + code.charCodeAt(index);
  }
  return Math.abs(hash).toString(36);
}

function mermaidElementId(
  id: string,
  code: string,
  colorScheme: MermaidColorScheme,
): string {
  return `crewon-mermaid-${id.replace(/[^a-zA-Z0-9_-]/g, "")}-${colorScheme}-${hashDiagramId(code)}`;
}

export function isMermaidSyntaxErrorSvg(svg: string): boolean {
  const normalized = svg.toLowerCase();
  return (
    normalized.includes("syntax error in text") ||
    (normalized.includes("mermaid version") &&
      normalized.includes("syntax error"))
  );
}

export function mermaidThemePalette(colorScheme: MermaidColorScheme) {
  const dark = colorScheme === "dark";
  return {
    actorBkg: dark ? "#303032" : "#f7f7f8",
    actorBorder: dark ? "#66666b" : "#b6b6bb",
    actorTextColor: dark ? "#f4f4f5" : "#27272a",
    background: dark ? "#232323" : "#ffffff",
    clusterBkg: dark ? "#29292b" : "#fafafa",
    clusterBorder: dark ? "#55555a" : "#d4d4d8",
    edgeLabelBackground: dark ? "#232323" : "#ffffff",
    fontSize: "14px",
    lineColor: dark ? "#8b8b91" : "#71717a",
    mainBkg: dark ? "#303032" : "#f7f7f8",
    nodeBorder: dark ? "#66666b" : "#b6b6bb",
    noteBkgColor: dark ? "#39372f" : "#fffbea",
    noteBorderColor: dark ? "#78715d" : "#d6c88e",
    noteTextColor: dark ? "#f4f4f5" : "#3f3f46",
    primaryBorderColor: dark ? "#707076" : "#a8a8ae",
    primaryColor: dark ? "#343436" : "#f4f4f5",
    primaryTextColor: dark ? "#f4f4f5" : "#27272a",
    secondaryBorderColor: dark ? "#5d5d62" : "#c8c8cd",
    secondaryColor: dark ? "#29292b" : "#ffffff",
    secondaryTextColor: dark ? "#eeeeef" : "#27272a",
    signalColor: dark ? "#a1a1aa" : "#52525b",
    signalTextColor: dark ? "#f4f4f5" : "#27272a",
    tertiaryColor: dark ? "#252527" : "#fafafa",
    tertiaryTextColor: dark ? "#eeeeef" : "#3f3f46",
    textColor: dark ? "#f4f4f5" : "#27272a",
  };
}

function readCachedMermaidSvg(
  code: string,
  elementId: string,
  colorScheme: MermaidColorScheme,
): string | null {
  const cacheKey = `${colorScheme}:${code}`;
  const cached = mermaidRenderCache.get(cacheKey);
  if (!cached) {
    return null;
  }
  mermaidRenderCache.delete(cacheKey);
  mermaidRenderCache.set(cacheKey, cached);
  return cached.elementId === elementId
    ? cached.svg
    : cached.svg.replaceAll(cached.elementId, elementId);
}

async function renderMermaidSvg(
  code: string,
  elementId: string,
  colorScheme: MermaidColorScheme,
): Promise<string> {
  const cacheKey = `${colorScheme}:${code}`;
  const cachedSvg = readCachedMermaidSvg(code, elementId, colorScheme);
  if (cachedSvg) {
    return cachedSvg;
  }

  const { default: mermaid } = await import("mermaid");
  if (mermaidInitializedScheme !== colorScheme) {
    mermaid.initialize({
      fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      flowchart: {
        curve: "basis",
        nodeSpacing: 36,
        padding: 12,
        rankSpacing: 42,
        useMaxWidth: true,
      },
      securityLevel: "strict",
      startOnLoad: false,
      theme: "base",
      themeVariables: mermaidThemePalette(colorScheme),
    });
    mermaidInitializedScheme = colorScheme;
  }

  const { svg } = await mermaid.render(elementId, code);
  if (isMermaidSyntaxErrorSvg(svg)) {
    throw new Error("Mermaid returned a syntax error diagram.");
  }

  mermaidRenderCache.set(cacheKey, { elementId, svg });
  while (mermaidRenderCache.size > MERMAID_RENDER_CACHE_LIMIT) {
    const oldestKey = mermaidRenderCache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    mermaidRenderCache.delete(oldestKey);
  }

  return svg;
}

async function drainMermaidRenderQueue(): Promise<void> {
  if (mermaidRenderQueueRunning) {
    return;
  }

  mermaidRenderQueueRunning = true;
  try {
    while (mermaidRenderOrder.length > 0) {
      const slotId = mermaidRenderOrder.shift();
      if (!slotId) {
        continue;
      }
      const request = mermaidRenderQueue.get(slotId);
      if (!request) {
        continue;
      }
      mermaidRenderQueue.delete(slotId);
      try {
        request.resolve(
          await renderMermaidSvg(
            request.code,
            request.elementId,
            request.colorScheme,
          ),
        );
      } catch (error) {
        request.reject(error);
      }
    }
  } finally {
    mermaidRenderQueueRunning = false;
    if (mermaidRenderOrder.length > 0) {
      void drainMermaidRenderQueue();
    }
  }
}

function scheduleMermaidRender({
  code,
  colorScheme,
  elementId,
  slotId,
}: {
  code: string;
  colorScheme: MermaidColorScheme;
  elementId: string;
  slotId: string;
}): { cancel: () => void; result: Promise<string> } {
  let request: MermaidRenderRequest;
  const result = new Promise<string>((resolve, reject) => {
    request = { code, colorScheme, elementId, reject, resolve, slotId };
  });
  const superseded = mermaidRenderQueue.get(slotId);
  if (superseded) {
    superseded.reject(new MermaidRenderSupersededError());
  } else {
    mermaidRenderOrder.push(slotId);
  }
  mermaidRenderQueue.set(slotId, request!);
  void drainMermaidRenderQueue();

  return {
    cancel: () => {
      if (mermaidRenderQueue.get(slotId) !== request) {
        return;
      }
      mermaidRenderQueue.delete(slotId);
      request.reject(new MermaidRenderSupersededError());
    },
    result,
  };
}

function currentMermaidColorScheme(): MermaidColorScheme {
  if (typeof document === "undefined") {
    return "light";
  }
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function useMermaidColorScheme(): MermaidColorScheme {
  const [colorScheme, setColorScheme] = useState(currentMermaidColorScheme);

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setColorScheme(currentMermaidColorScheme());
    });
    observer.observe(root, {
      attributeFilter: ["data-theme"],
      attributes: true,
    });
    return () => observer.disconnect();
  }, []);

  return colorScheme;
}

export function MermaidRenderedDiagram({
  code,
  settled = true,
  svg,
}: {
  code: string;
  settled?: boolean;
  svg: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const expandButtonRef = useRef<HTMLButtonElement | null>(null);

  const dismissLightbox = useCallback(() => {
    setExpanded(false);
    window.requestAnimationFrame(() => {
      expandButtonRef.current?.focus({ preventScroll: true });
    });
  }, []);

  useEffect(() => {
    setExpanded(false);
  }, [svg]);

  useEffect(() => {
    if (!expanded) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dismissLightbox();
      }
    };

    document.body.classList.add("mermaid-lightbox-open");
    document.addEventListener("keydown", handleKeyDown);
    window.setTimeout(
      () => closeButtonRef.current?.focus({ preventScroll: true }),
      0,
    );

    return () => {
      document.body.classList.remove("mermaid-lightbox-open");
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [dismissLightbox, expanded]);

  const lightbox =
    settled && expanded && typeof document !== "undefined"
      ? createPortal(
          <div
            aria-label="Expanded Mermaid diagram"
            aria-modal="true"
            className="mermaid-lightbox"
            onClick={(event) => {
              if (event.target === event.currentTarget) {
                dismissLightbox();
              }
            }}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              dismissLightbox();
            }}
            role="dialog"
          >
            <section className="mermaid-lightbox-card">
              <header className="mermaid-lightbox-header">
                <strong>Mermaid</strong>
                <button
                  aria-label="Close expanded Mermaid diagram"
                  className="mermaid-lightbox-close"
                  onClick={dismissLightbox}
                  ref={closeButtonRef}
                  title="Close"
                  type="button"
                >
                  <X size={16} strokeWidth={1.9} />
                </button>
              </header>
              <div
                className="mermaid-lightbox-diagram"
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            </section>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <div
        aria-label={settled ? "Mermaid diagram" : "Mermaid live preview"}
        className={`mermaid-diagram${settled ? "" : " mermaid-live-diagram"}`}
        dangerouslySetInnerHTML={{ __html: svg }}
        role="img"
      />
      {settled ? (
        <>
          <button
            ref={expandButtonRef}
            aria-label="Expand Mermaid diagram"
            className="mermaid-zoom-button"
            onClick={() => setExpanded(true)}
            title="Expand diagram"
            type="button"
          >
            <Maximize2 size={14} strokeWidth={1.9} />
          </button>
          <details className="mermaid-source">
            <summary>Source</summary>
            <pre>
              <code className="language-mermaid">{code}</code>
            </pre>
          </details>
        </>
      ) : null}
      {lightbox}
    </>
  );
}

function MermaidStreamingPlaceholder() {
  return (
    <div
      aria-label="Building Mermaid diagram"
      className="mermaid-streaming-placeholder"
      role="status"
    >
      <span className="mermaid-placeholder-node" />
      <span className="mermaid-placeholder-link" />
      <span className="mermaid-placeholder-node is-center" />
      <span className="mermaid-placeholder-link" />
      <span className="mermaid-placeholder-node" />
    </div>
  );
}

export function MermaidDiagramFrame({
  code,
  complete,
  displayState,
  errorMessage,
  svg,
}: {
  code: string;
  complete: boolean;
  displayState: MermaidDisplayState;
  errorMessage?: string;
  svg?: string | null;
}) {
  const statusLabel =
    displayState === "loading"
      ? "Building diagram"
      : displayState === "live"
        ? "Live preview"
        : displayState === "error"
          ? "Source fallback"
          : null;

  return (
    <figure
      className="mermaid-block"
      data-complete={complete}
      data-renderer="mermaid"
      data-state={displayState}
    >
      <figcaption>
        <span className="mermaid-caption-title">Mermaid</span>
        {statusLabel ? (
          <em className="mermaid-render-status" role="status">
            <span aria-hidden="true" />
            {statusLabel}
          </em>
        ) : null}
      </figcaption>
      {(displayState === "rendered" || displayState === "live") && svg ? (
        <MermaidRenderedDiagram
          code={code}
          settled={displayState === "rendered"}
          svg={svg}
        />
      ) : displayState === "error" ? (
        <>
          <pre>
            <code className="language-mermaid">{code}</code>
          </pre>
          <p className="mermaid-error" role="status" title={errorMessage}>
            Mermaid diagram could not be rendered.
          </p>
        </>
      ) : (
        <MermaidStreamingPlaceholder />
      )}
    </figure>
  );
}

function MermaidDiagram({
  code,
  complete,
}: {
  code: string;
  complete: boolean;
}) {
  const reactId = useId();
  const colorScheme = useMermaidColorScheme();
  const elementId = useMemo(
    () => mermaidElementId(reactId, code, colorScheme),
    [code, colorScheme, reactId],
  );
  const [state, setState] = useState<MermaidState>(() => {
    const trimmed = code.trim();
    const cachedSvg = trimmed
      ? readCachedMermaidSvg(trimmed, elementId, colorScheme)
      : null;
    return cachedSvg
      ? {
          code: trimmed,
          colorScheme,
          status: "rendered",
          svg: cachedSvg,
        }
      : { code: "", status: "idle", svg: null };
  });
  const lastRenderedRef = useRef<{
    code: string;
    colorScheme: MermaidColorScheme;
    svg: string;
  } | null>(
    state.status === "rendered"
      ? {
          code: state.code,
          colorScheme: state.colorScheme,
          svg: state.svg,
        }
      : null,
  );
  const nextPreviewAtRef = useRef<number | null>(null);

  useEffect(() => {
    const trimmed = code.trim();
    if (!trimmed) {
      lastRenderedRef.current = null;
      nextPreviewAtRef.current = null;
      setState({ code: "", status: "idle", svg: null });
      return;
    }

    const lastRendered = lastRenderedRef.current;
    if (
      lastRendered?.code === trimmed &&
      lastRendered.colorScheme === colorScheme
    ) {
      setState({
        code: trimmed,
        colorScheme,
        status: "rendered",
        svg: lastRendered.svg,
      });
      return;
    }

    const retainedSvg =
      lastRendered?.colorScheme === colorScheme ? lastRendered.svg : null;
    let cancelled = false;
    setState({
      code: trimmed,
      colorScheme,
      status: "loading",
      svg: retainedSvg,
    });

    const now = Date.now();
    const previewAt = complete
      ? now
      : (nextPreviewAtRef.current ?? now + MERMAID_LIVE_RENDER_INTERVAL_MS);
    const delay = Math.max(0, previewAt - now);
    if (!complete) {
      nextPreviewAtRef.current = previewAt;
    } else {
      nextPreviewAtRef.current = null;
    }

    let scheduledRender: ReturnType<typeof scheduleMermaidRender> | null = null;
    const timer = window.setTimeout(() => {
      if (!complete) {
        nextPreviewAtRef.current = Date.now() + MERMAID_LIVE_RENDER_INTERVAL_MS;
      }
      scheduledRender = scheduleMermaidRender({
        code: trimmed,
        colorScheme,
        elementId,
        slotId: reactId,
      });
      scheduledRender.result
        .then((svg) => {
          if (cancelled) {
            return;
          }
          lastRenderedRef.current = { code: trimmed, colorScheme, svg };
          setState({
            code: trimmed,
            colorScheme,
            status: "rendered",
            svg,
          });
        })
        .catch((error: unknown) => {
          if (cancelled || error instanceof MermaidRenderSupersededError) {
            return;
          }
          if (!complete) {
            setState({
              code: trimmed,
              colorScheme,
              status: "holding",
              svg: retainedSvg,
            });
            return;
          }
          setState({
            code: trimmed,
            colorScheme,
            message: error instanceof Error ? error.message : String(error),
            status: "error",
            svg: null,
          });
        });
    }, delay);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      scheduledRender?.cancel();
    };
  }, [code, colorScheme, complete, elementId, reactId]);

  const trimmedCode = code.trim();
  const stateMatchesInput =
    state.code === trimmedCode &&
    (state.status === "idle" || state.colorScheme === colorScheme);
  const displayState: MermaidDisplayState =
    complete && !trimmedCode
      ? "error"
      : stateMatchesInput && state.status === "error"
        ? "error"
        : stateMatchesInput && state.status === "rendered" && complete
          ? "rendered"
          : state.svg
            ? "live"
            : "loading";

  return (
    <MermaidDiagramFrame
      code={code}
      complete={complete}
      displayState={displayState}
      errorMessage={
        stateMatchesInput && state.status === "error"
          ? state.message
          : undefined
      }
      svg={state.svg}
    />
  );
}

function fenceLanguage(line: string): string | null {
  const rawLanguage = line.replace(/^```/, "").trim().split(/\s+/)[0] ?? "";
  return rawLanguage ? rawLanguage.toLowerCase() : null;
}

function codeLanguageClass(language: string | null): string | undefined {
  if (!language) {
    return undefined;
  }

  return `language-${language.replace(/[^a-z0-9_-]/g, "-")}`;
}

function codeLanguageLabel(language: string | null): string | null {
  if (!language) {
    return null;
  }

  const labels: Record<string, string> = {
    bash: "Bash",
    css: "CSS",
    html: "HTML",
    js: "JavaScript",
    json: "JSON",
    jsx: "JSX",
    md: "Markdown",
    mermaid: "Mermaid",
    py: "Python",
    python: "Python",
    rust: "Rust",
    sh: "Shell",
    ts: "TypeScript",
    tsx: "TSX",
    txt: "Text",
    xml: "XML",
    yaml: "YAML",
    yml: "YAML",
    zsh: "Zsh",
  };

  return labels[language] ?? language.slice(0, 28);
}

function splitMarkdownSegments(text: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  const markdownLines: string[] = [];
  let codeBlock: { language: string | null; lines: string[] } | null = null;

  function flushMarkdown() {
    if (markdownLines.length === 0) {
      return;
    }

    segments.push({ text: markdownLines.join("\n"), type: "markdown" });
    markdownLines.length = 0;
  }

  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (line.trim().startsWith("```")) {
      if (codeBlock) {
        segments.push({
          code: codeBlock.lines.join("\n"),
          complete: true,
          language: codeBlock.language,
          type: "code",
        });
        codeBlock = null;
      } else {
        flushMarkdown();
        codeBlock = { language: fenceLanguage(line.trim()), lines: [] };
      }
      continue;
    }

    if (codeBlock) {
      codeBlock.lines.push(line);
    } else {
      markdownLines.push(line);
    }
  }

  if (codeBlock) {
    segments.push({
      code: codeBlock.lines.join("\n"),
      complete: false,
      language: codeBlock.language,
      type: "code",
    });
  }
  flushMarkdown();

  return segments;
}

const CODE_COPY_RESET_MS = 1600;

function CodeBlockCopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
    },
    [],
  );

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      return;
    }
    setCopied(true);
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
    }
    resetTimerRef.current = window.setTimeout(() => {
      resetTimerRef.current = null;
      setCopied(false);
    }, CODE_COPY_RESET_MS);
  };

  return (
    <button
      aria-label={copied ? "Copied" : "Copy code"}
      className="markdown-code-copy"
      data-copied={copied ? "true" : undefined}
      onClick={() => void handleCopy()}
      title={copied ? "Copied" : "Copy code"}
      type="button"
    >
      {copied ? (
        <Check size={13} strokeWidth={2} aria-hidden="true" />
      ) : (
        <Copy size={13} strokeWidth={1.8} aria-hidden="true" />
      )}
      <span>{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

function renderCodeSegment(
  segment: Extract<MarkdownSegment, { type: "code" }>,
  key: string,
  options: RenderMarkdownOptions,
) {
  if (segment.language === "mermaid") {
    return (
      <MermaidDiagram
        code={segment.code}
        complete={options.streaming !== true}
        key={key}
      />
    );
  }

  const languageLabel = codeLanguageLabel(segment.language);

  return (
    <figure
      className="markdown-code-block"
      data-complete={segment.complete}
      data-language={segment.language ?? undefined}
      key={key}
    >
      <figcaption>
        {languageLabel ? <span>{languageLabel}</span> : null}
        {!segment.complete ? <em>Streaming</em> : null}
        <CodeBlockCopyButton code={segment.code} />
      </figcaption>
      <pre className="markdown-code-pre">
        <code className={codeLanguageClass(segment.language)}>
          {segment.code}
        </code>
      </pre>
    </figure>
  );
}

function isMarkdownMentionBoundary(value: string): boolean {
  return value.length === 0 || !/[\p{L}\p{M}\p{N}_-]/u.test(value);
}

function isMarkdownMentionStart(text: string, index: number): boolean {
  return index === 0 || !/[A-Za-z0-9._%+-]/.test(text[index - 1]);
}

function markdownMentionNodes(
  text: string,
  mentions: readonly MarkdownMention[],
): MarkdownAstNode[] {
  const nodes: MarkdownAstNode[] = [];
  let textStart = 0;
  let index = 0;

  while (index < text.length) {
    if (text[index] !== "@" || !isMarkdownMentionStart(text, index)) {
      index += 1;
      continue;
    }
    const mention = mentions.find(({ displayText }) => {
      if (!text.startsWith(displayText, index)) {
        return false;
      }
      const remainder = text.slice(index + displayText.length);
      const nextCodePoint = remainder.codePointAt(0);
      const nextCharacter =
        nextCodePoint === undefined ? "" : String.fromCodePoint(nextCodePoint);
      return isMarkdownMentionBoundary(nextCharacter);
    });
    if (!mention) {
      index += 1;
      continue;
    }

    if (index > textStart) {
      nodes.push({ type: "text", value: text.slice(textStart, index) });
    }
    nodes.push({
      children: [{ type: "text", value: mention.displayText }],
      type: "link",
      url: `${MARKDOWN_MENTION_FRAGMENT_PREFIX}${encodeURIComponent(mention.id)}`,
    });
    index += mention.displayText.length;
    textStart = index;
  }

  if (textStart < text.length) {
    nodes.push({ type: "text", value: text.slice(textStart) });
  }
  return nodes;
}

function markdownMentionPlugin(mentions: readonly MarkdownMention[]) {
  const candidates = [...mentions]
    .filter(({ displayText, id }) => displayText.startsWith("@") && id.trim())
    .sort((left, right) => right.displayText.length - left.displayText.length);

  return () => (tree: MarkdownAstNode) => {
    function visit(node: MarkdownAstNode) {
      if (
        markdownMentionSkippedNodeTypes.has(node.type) ||
        !node.children ||
        candidates.length === 0
      ) {
        return;
      }
      node.children = node.children.flatMap((child) => {
        if (child.type === "text" && child.value?.includes("@")) {
          return markdownMentionNodes(child.value, candidates);
        }
        visit(child);
        return [child];
      });
    }

    visit(tree);
  };
}

function markdownMentionId(href: string | undefined): string | null {
  if (!href?.startsWith(MARKDOWN_MENTION_FRAGMENT_PREFIX)) {
    return null;
  }
  try {
    return decodeURIComponent(
      href.slice(MARKDOWN_MENTION_FRAGMENT_PREFIX.length),
    );
  } catch {
    return null;
  }
}

function renderMarkdownSegment(
  text: string,
  key: string,
  options: RenderMarkdownOptions,
): ReactNode {
  const mentions = options.mentions ?? [];
  const mentionPlugin = markdownMentionPlugin(mentions);
  return (
    <ReactMarkdown
      components={{
        a: ({ children, href, node: _node, ...props }) => {
          const memberId = markdownMentionId(href);
          const isMemberMention = mentions.some(
            (mention) =>
              mention.id === memberId && mention.displayText === children,
          );
          return memberId && isMemberMention ? (
            <span className="office-mention" data-member-id={memberId}>
              {children}
            </span>
          ) : (
            <a {...props} href={href} rel="noreferrer" target="_blank">
              {children}
            </a>
          );
        },
      }}
      key={key}
      remarkPlugins={
        mentions.length > 0 ? [remarkGfm, mentionPlugin] : [remarkGfm]
      }
    >
      {text}
    </ReactMarkdown>
  );
}

export function renderMarkdown(
  text: string,
  options: RenderMarkdownOptions = {},
) {
  const blocks = splitMarkdownSegments(text)
    .map((segment, index) =>
      segment.type === "code"
        ? renderCodeSegment(segment, `code-${index}`, options)
        : renderMarkdownSegment(segment.text, `markdown-${index}`, options),
    )
    .filter(Boolean);

  return <div className="markdown-content">{blocks}</div>;
}
