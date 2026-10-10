import { useEffect, useState } from "react";

const narrowSidebarQuery = "(max-width: 680px)";

export function useCommandSidebarCollapse() {
  const [collapsed, setCollapsed] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(narrowSidebarQuery).matches
      : false,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(narrowSidebarQuery);
    function closeOnNarrow(event: MediaQueryListEvent) {
      if (event.matches) setCollapsed(true);
    }
    media.addEventListener?.("change", closeOnNarrow);
    return () => media.removeEventListener?.("change", closeOnNarrow);
  }, []);
  return [collapsed, setCollapsed] as const;
}
