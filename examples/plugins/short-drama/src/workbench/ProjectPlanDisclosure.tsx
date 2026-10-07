import { ChevronDown, Workflow } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import type { ProjectTextPlanController } from "./ProjectTextPlanController";

export function ProjectPlanDisclosure({
  controller,
  hasDraft,
  children,
}: {
  controller: ProjectTextPlanController;
  hasDraft: boolean;
  children: ReactNode;
}) {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const details = useRef<HTMLDetailsElement>(null);
  const reveal =
    hasDraft || Boolean(snapshot.view || snapshot.pending || snapshot.error);
  useEffect(() => {
    if (reveal && details.current) details.current.open = true;
  }, [reveal]);
  return (
    <details className="drama-plan-disclosure" ref={details}>
      <summary>
        <Workflow size={16} />
        <strong>自动创作计划</strong>
        <span>按阶段推进需求、大纲与剧本</span>
        <ChevronDown size={16} />
      </summary>
      {children}
    </details>
  );
}
