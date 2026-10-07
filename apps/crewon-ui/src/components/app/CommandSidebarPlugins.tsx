import { Blocks, ChevronDown, Puzzle } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { Locale } from "../../lib/i18n";
import styles from "./CommandSidebarPlugins.module.css";

/** Plugins share one collapsible directory; opening it never changes the active module. */
export function CommandSidebarPlugins({
  modules,
  locale,
}: Readonly<{
  modules: readonly Readonly<{
    id: string;
    label: string;
    active: boolean;
    onOpen(): void;
  }>[];
  locale: Locale;
}>) {
  const active = modules.find((module) => module.active);
  const [expanded, setExpanded] = useState(Boolean(active));
  const id = useId();
  useEffect(() => {
    if (active) setExpanded(true);
  }, [active?.id]);
  if (!modules.length) return null;
  return (
    <div className={styles.group}>
      <button
        type="button"
        className={styles.toggle}
        aria-expanded={expanded}
        aria-controls={id}
        aria-label={locale === "zh" ? "插件" : "Plugins"}
        data-plugin-group-active={Boolean(active)}
        onClick={() => setExpanded(!expanded)}
      >
        <span className="nav-glyph" aria-hidden="true">
          <Puzzle />
        </span>
        <strong>{locale === "zh" ? "插件" : "Plugins"}</strong>
        <span className={styles.meta}>
          <span className={styles.hint}>
            {!expanded && active ? active.label : modules.length}
          </span>
          <ChevronDown className={styles.chevron} aria-hidden="true" />
        </span>
      </button>
      <div id={id} hidden={!expanded} className={styles.items}>
        {modules.map((module) => (
          <button
            type="button"
            key={module.id}
            aria-current={module.active ? "page" : undefined}
            className={module.active ? "active" : undefined}
            data-host-module-target={module.id}
            onClick={module.onOpen}
          >
            <span className="nav-glyph" aria-hidden="true">
              <Blocks />
            </span>
            <strong>{module.label}</strong>
          </button>
        ))}
      </div>
    </div>
  );
}
