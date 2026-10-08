import type {
  FoundationSnapshot,
  ProjectFoundationController,
} from "./ProjectFoundationController";
export function ProjectFoundationFeedback({
  controller,
  snapshot,
  onRetried,
}: {
  controller: ProjectFoundationController;
  snapshot: FoundationSnapshot;
  onRetried?(): void;
}) {
  return (
    <>
      {snapshot.error && (
        <p className="detail-note" role="alert">
          {snapshot.error}
        </p>
      )}
      {snapshot.pending && (
        <button
          className="button secondary"
          type="button"
          disabled={snapshot.saving}
          onClick={() =>
            void controller.retry().then((saved) => {
              if (saved) onRetried?.();
            })
          }
        >
          重试原保存请求
        </button>
      )}
      {snapshot.conflict && (
        <button
          className="button secondary"
          type="button"
          disabled={snapshot.loading}
          onClick={() => void controller.refresh()}
        >
          重新读取创作资料
        </button>
      )}
      {snapshot.notice && (
        <p className="detail-note" role="status">
          {snapshot.notice}
        </p>
      )}
    </>
  );
}
