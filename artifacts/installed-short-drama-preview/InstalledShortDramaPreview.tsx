import { useEffect, useRef, useState } from "react";
import { ControlApiClient } from "@crewon/control-client";
import { ShortDramaPluginPreview } from "../../apps/crewon-ui/src/components/app/ShortDramaPluginPreview";
import { useInstalledPluginModules } from "../../apps/crewon-ui/src/lib/app/useInstalledPluginModules";
import { getInitialLocale } from "../../apps/crewon-ui/src/lib/i18n";
import { getInitialTheme } from "../../apps/crewon-ui/src/lib/theme";
import {
  diagnosticPreviewFetch,
  previewDiagnosticCode,
  readPreviewEvents,
  recordPreviewEvent,
} from "./preview-diagnostics";

const moduleId = JSON.stringify(["crewon.short-drama", "workbench"]);

/** Named local fixture; this does not create a login session or grant task authority. */
export function InstalledShortDramaPreview() {
  const [client, setClient] = useState<ControlApiClient | null>(null);
  const [bootstrapFailed, setBootstrapFailed] = useState(false);
  const [diagnosticText, setDiagnosticText] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(), 5_000);
    let active = true;
    void (async () => {
      try {
        const response = await diagnosticPreviewFetch("/control-api/session", {
          cache: "no-store",
          credentials: "same-origin",
          signal: abort.signal,
          headers: { Accept: "application/json" },
        });
        if (
          !response.ok ||
          !/^application\/json(?:;|$)/iu.test(
            response.headers.get("content-type") ?? "",
          )
        )
          throw new Error("named_preview_session_unavailable");
        const text = await response.text();
        if (text.length > 8 * 1024)
          throw new Error("named_preview_session_invalid");
        const session: unknown = JSON.parse(text);
        if (
          typeof session !== "object" ||
          session === null ||
          Array.isArray(session) ||
          Object.keys(session).sort().join(",") !== "baseUrl,csrfToken" ||
          !("baseUrl" in session) ||
          session.baseUrl !== "/" ||
          !("csrfToken" in session) ||
          typeof session.csrfToken !== "string" ||
          !/^[A-Za-z0-9_-]{43}$/u.test(session.csrfToken)
        )
          throw new Error("named_preview_session_invalid");
        const next = new ControlApiClient({
          baseUrl: new URL(session.baseUrl, location.origin).toString(),
          origin: location.origin,
          csrfToken: session.csrfToken,
          fetch: diagnosticPreviewFetch,
        });
        if (active) setClient(next);
      } catch (error) {
        recordPreviewEvent({
          category: "bootstrap",
          method: "GET",
          code: previewDiagnosticCode(error),
        });
        if (active) setBootstrapFailed(true);
      } finally {
        clearTimeout(deadline);
      }
    })();
    return () => {
      active = false;
      clearTimeout(deadline);
      abort.abort();
    };
  }, []);
  const { hostModules, getDiagnostics } = useInstalledPluginModules({
    client,
    sessionKey: "named-local-installed-short-drama-preview:no-login",
    theme: getInitialTheme(),
    locale: getInitialLocale(),
  });
  const latestDiagnostics = useRef(getDiagnostics);
  latestDiagnostics.current = getDiagnostics;
  const reportDiagnostics = () => {
    const hooks = latestDiagnostics.current().map(previewDiagnosticCode);
    setDiagnosticText(
      JSON.stringify(
        {
          clientReady: client !== null,
          bootstrapFailed,
          modules: hostModules.length,
          hooks,
          requests: readPreviewEvents(),
        },
        null,
        2,
      ).slice(0, 8 * 1024),
    );
  };
  const latestReport = useRef(reportDiagnostics);
  latestReport.current = reportDiagnostics;
  useEffect(() => {
    const timer = setInterval(() => latestReport.current(), 500);
    return () => clearInterval(timer);
  }, []);
  const module = hostModules.find((item) => item.id === moduleId);
  return (
    <>
      <output hidden data-installed-preview-diagnostics>
        {diagnosticText}
      </output>
      <ShortDramaPluginPreview
        referenceImage=""
        moduleOverride={
          module ?? {
            id: moduleId,
            label: "AI 短剧",
            content: ({ active }) =>
              active ? (
                <p role="status">
                  {bootstrapFailed
                    ? "本机预览会话不可用，请刷新后重试。"
                    : "正在读取已安装的短剧页面…"}
                </p>
              ) : null,
          }
        }
      />
    </>
  );
}
