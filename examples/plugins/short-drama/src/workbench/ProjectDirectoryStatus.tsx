import type { ProjectSnapshot } from "./creative-project-controller";

/** Keep failed reads distinct from an empty directory. Retry is a user action, never a write. */
export function ProjectDirectoryStatus({
  snapshot,
  onRetry,
}: {
  snapshot: Pick<ProjectSnapshot, "phase" | "error">;
  onRetry(): void;
}) {
  if (snapshot.phase === "waiting" || snapshot.phase === "loading")
    return (
      <p className="detail-note" role="status">
        正在读取项目…
      </p>
    );
  if (snapshot.phase !== "unavailable") return null;
  return (
    <div className="detail-note" role="alert">
      <p>{snapshot.error ?? "项目暂时无法读取。"}</p>
      <button type="button" className="drama-sidebar-item" onClick={onRetry}>
        重试读取项目
      </button>
    </div>
  );
}
