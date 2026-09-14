import { useEffect, useRef, useState } from "react";

/**
 * The mount-lifetime cleanup must not share a closure context with replay
 * handlers: heap snapshots showed that context retaining an old whole Thread.
 * Keep this hook outside MessageActions and pass text only when copying.
 */
export function useMessageCopyFeedback() {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const lifetime = useRef({
    active: false,
    request: 0,
    timeout: null as ReturnType<typeof setTimeout> | null,
  });
  useEffect(() => {
    const owner = lifetime.current;
    owner.active = true;
    return () => {
      owner.active = false;
      owner.request++;
      if (owner.timeout !== null) clearTimeout(owner.timeout);
      owner.timeout = null;
    };
  }, []);
  return {
    copyState,
    async copyText(text: string) {
      const owner = lifetime.current;
      if (!owner.active) return;
      const request = ++owner.request;
      if (owner.timeout !== null) clearTimeout(owner.timeout);
      owner.timeout = null;
      let next: "copied" | "failed";
      try {
        await navigator.clipboard.writeText(text);
        next = "copied";
      } catch {
        next = "failed";
      }
      if (!owner.active || owner.request !== request) return;
      setCopyState(next);
      owner.timeout = setTimeout(() => {
        owner.timeout = null;
        setCopyState("idle");
      }, 2000);
    },
  };
}
