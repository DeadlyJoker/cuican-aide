import { LoaderCircle } from "lucide-react";
import { lazy, Suspense } from "react";

import type { CommandSettingsRouteProps } from "./CommandSettingsRoute";

const LazyCommandSettingsRoute = lazy(() =>
  import("./CommandSettingsRoute").then((module) => ({
    default: module.CommandSettingsRoute,
  })),
);

export function CommandSettingsLazyRoute(props: CommandSettingsRouteProps) {
  return (
    <Suspense
      fallback={
        <section className="screen-shell command-screen settings-command-screen">
          <section className="desktop-window command-window settings-command-window">
            <section className="command-canvas settings-command-canvas">
              <section className="settings-page" aria-label="Settings">
                <main className="settings-content">
                  <div
                    className="route-loading-state"
                    role="status"
                    aria-live="polite"
                  >
                    <LoaderCircle aria-hidden="true" size={18} />
                    <strong>
                      {props.locale === "zh"
                        ? "正在加载设置…"
                        : "Loading settings…"}
                    </strong>
                    <small>
                      {props.locale === "zh"
                        ? "首次打开需要载入模块，稍等一下。"
                        : "Loading the module for the first time takes a moment."}
                    </small>
                  </div>
                </main>
              </section>
            </section>
          </section>
        </section>
      }
    >
      <LazyCommandSettingsRoute {...props} />
    </Suspense>
  );
}
