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
                  <p className="settings-loading">
                    {props.locale === "zh"
                      ? "正在加载设置…"
                      : "Loading settings…"}
                  </p>
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
