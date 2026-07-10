import {
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
import { Maximize2, X } from "lucide-react";

type MarkdownSegment =
  | { type: "markdown"; text: string }
  | { type: "code"; code: string; complete: boolean; language: string | null };

type MermaidState =
  | { status: "source" }
  | { status: "loading"; code: string }
  | { status: "rendered"; code: string; svg: string }
  | { status: "error"; code: string; message: string };

let mermaidInitialized = false;

function hashDiagramId(code: string): string {
  let hash = 0;
  for (let index = 0; index < code.length; index += 1) {
    hash = Math.imul(31, hash) + code.charCodeAt(index);
  }
  return Math.abs(hash).toString(36);
}

function mermaidElementId(id: string, code: string): string {
  return `crewon-mermaid-${id.replace(/[^a-zA-Z0-9_-]/g, "")}-${hashDiagramId(code)}`;
}

export function isMermaidSyntaxErrorSvg(svg: string): boolean {
  const normalized = svg.toLowerCase();
  return (
    normalized.includes("syntax error in text") ||
    (normalized.includes("mermaid version") && normalized.includes("syntax error"))
  );
}

async function renderMermaidSvg(code: string, elementId: string): Promise<string> {
  const { default: mermaid } = await import("mermaid");
  if (!mermaidInitialized) {
    mermaid.initialize({
      fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      securityLevel: "strict",
      startOnLoad: false,
      theme: "base",
      themeVariables: {
        actorBkg: "#f8fafc",
        actorBorder: "#94a3b8",
        edgeLabelBackground: "#ffffff",
        lineColor: "#64748b",
        mainBkg: "#f8fafc",
        nodeBorder: "#94a3b8",
        primaryBorderColor: "#7dd3fc",
        primaryColor: "#eff6ff",
        primaryTextColor: "#0f172a",
        secondaryBorderColor: "#cbd5e1",
        secondaryColor: "#f8fafc",
        tertiaryColor: "#ffffff",
      },
    });
    mermaidInitialized = true;
  }

  const { svg } = await mermaid.render(elementId, code);
  if (isMermaidSyntaxErrorSvg(svg)) {
    throw new Error("Mermaid returned a syntax error diagram.");
  }

  return svg;
}

export function MermaidRenderedDiagram({
  code,
  svg,
}: {
  code: string;
  svg: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

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
        setExpanded(false);
      }
    };

    document.body.classList.add("mermaid-lightbox-open");
    document.addEventListener("keydown", handleKeyDown);
    window.setTimeout(() => closeButtonRef.current?.focus({ preventScroll: true }), 0);

    return () => {
      document.body.classList.remove("mermaid-lightbox-open");
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [expanded]);

  const lightbox =
    expanded && typeof document !== "undefined"
      ? createPortal(
          <div
            aria-label="Expanded Mermaid diagram"
            aria-modal="true"
            className="mermaid-lightbox"
            onClick={(event) => {
              if (event.target === event.currentTarget) {
                setExpanded(false);
              }
            }}
            role="dialog"
          >
            <section className="mermaid-lightbox-card">
              <header className="mermaid-lightbox-header">
                <strong>Mermaid</strong>
                <button
                  aria-label="Close expanded Mermaid diagram"
                  className="mermaid-lightbox-close"
                  onClick={() => setExpanded(false)}
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
        className="mermaid-diagram"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <button
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
      {lightbox}
    </>
  );
}

function MermaidDiagram({ code, complete }: { code: string; complete: boolean }) {
  const reactId = useId();
  const elementId = useMemo(() => mermaidElementId(reactId, code), [code, reactId]);
  const [state, setState] = useState<MermaidState>({ status: "source" });

  useEffect(() => {
    const trimmed = code.trim();
    if (!complete || !trimmed) {
      setState({ status: "source" });
      return;
    }

    let cancelled = false;
    setState({ code: trimmed, status: "loading" });
    renderMermaidSvg(trimmed, elementId)
      .then((svg) => {
        if (!cancelled) {
          setState({ code: trimmed, status: "rendered", svg });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            code: trimmed,
            message: error instanceof Error ? error.message : String(error),
            status: "error",
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [code, complete, elementId]);

  const trimmedCode = code.trim();
  const stateMatchesCode = "code" in state ? state.code === trimmedCode : true;
  const displayStatus = complete && stateMatchesCode ? state.status : "source";

  return (
    <figure
      className="mermaid-block"
      data-complete={complete}
      data-renderer="mermaid"
      data-state={displayStatus}
    >
      <figcaption>
        <span>Mermaid</span>
        {!complete ? <em>Streaming source</em> : null}
        {displayStatus === "loading" ? <em>Rendering</em> : null}
        {displayStatus === "error" ? <em>Source fallback</em> : null}
      </figcaption>
      {displayStatus === "rendered" && state.status === "rendered" ? (
        <MermaidRenderedDiagram code={code} svg={state.svg} />
      ) : (
        <>
          <pre>
            <code className="language-mermaid">{code}</code>
          </pre>
          {!complete || displayStatus === "error" ? (
            <p
              className="mermaid-error"
              role="status"
              title={
                displayStatus === "error" && state.status === "error"
                  ? state.message
                  : undefined
              }
            >
              {complete
                ? "Mermaid diagram is not valid yet."
                : "Mermaid diagram is still streaming."}
            </p>
          ) : null}
        </>
      )}
    </figure>
  );
}

function fenceLanguage(line: string): string | null {
  const rawLanguage = line.replace(/^```/, "").trim().split(/\s+/)[0] ?? "";
  return rawLanguage ? rawLanguage.toLowerCase() : null;
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

function renderCodeSegment(segment: Extract<MarkdownSegment, { type: "code" }>, key: string) {
  if (segment.language === "mermaid") {
    return <MermaidDiagram code={segment.code} complete={segment.complete} key={key} />;
  }

  return (
    <pre data-language={segment.language ?? undefined} key={key}>
      <code className={segment.language ? `language-${segment.language}` : undefined}>
        {segment.code}
      </code>
    </pre>
  );
}

function renderMarkdownSegment(text: string, key: string): ReactNode {
  return (
    <ReactMarkdown
      components={{
        a: ({ children, ...props }) => (
          <a {...props} rel="noreferrer" target="_blank">
            {children}
          </a>
        ),
      }}
      key={key}
      remarkPlugins={[remarkGfm]}
    >
      {text}
    </ReactMarkdown>
  );
}

export function renderMarkdown(text: string) {
  const blocks = splitMarkdownSegments(text)
    .map((segment, index) =>
      segment.type === "code"
        ? renderCodeSegment(segment, `code-${index}`)
        : renderMarkdownSegment(segment.text, `markdown-${index}`),
    )
    .filter(Boolean);

  return <div className="markdown-content">{blocks}</div>;
}
