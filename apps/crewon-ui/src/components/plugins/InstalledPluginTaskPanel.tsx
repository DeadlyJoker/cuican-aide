import { ChevronDown } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import type { Locale } from "../../lib/i18n";
import styles from "./InstalledPluginTaskPanel.module.css";

/** Host recovery controls remain reachable without taking over the plugin's first screen. */
export function InstalledPluginTaskPanel({
  children,
  needsAttention,
  locale,
}: Readonly<{
  children: ReactNode;
  needsAttention: boolean;
  locale: Locale;
}>) {
  const panel = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (needsAttention && panel.current) panel.current.open = true;
  }, [needsAttention]);
  return (
    <details className={styles.panel} ref={panel}>
      <summary>
        <span>{locale === "zh" ? "任务与连接" : "Tasks and connection"}</span>
        {needsAttention && (
          <span role="status" className={styles.attention}>
            {locale === "zh" ? "需要处理" : "Needs attention"}
          </span>
        )}
        <ChevronDown size={14} aria-hidden="true" />
      </summary>
      <div className={styles.body}>{children}</div>
    </details>
  );
}
