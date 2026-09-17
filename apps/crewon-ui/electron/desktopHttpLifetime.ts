import type {
  WebContents,
  Event,
  WebContentsDidStartNavigationEventParams,
} from "electron";
import type { DesktopHttpTransport } from "./desktopHttp.ts";

/** Reload/crash is an ownership boundary even when the BrowserWindow survives. */
export function bindDesktopHttpLifetime(
  contents: WebContents,
  transport: DesktopHttpTransport,
) {
  const close = () => transport.close();
  const navigate = (
    details: Event<WebContentsDidStartNavigationEventParams>,
  ) => {
    if (details.isMainFrame && !details.isSameDocument) close();
  };
  contents.on("did-start-navigation", navigate);
  contents.on("render-process-gone", close);
  contents.once("destroyed", () => {
    contents.off("did-start-navigation", navigate);
    contents.off("render-process-gone", close);
    close();
  });
}
