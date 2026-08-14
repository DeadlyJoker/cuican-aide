import type { ControlKnowledgeSelection } from "../lib/control-runtime/controlComposerResourceDiscovery";

export function ControlKnowledgeSelectionList({
  selections,
}: {
  selections: readonly ControlKnowledgeSelection[];
}) {
  if (selections.length === 0) return null;
  return (
    <section className="context-palette-section" aria-label="Knowledge">
      <header>Knowledge</header>
      {selections.map((selection) => (
        <button
          aria-disabled="true"
          disabled
          key={selection.reference.knowledgeId}
          title="Knowledge 将在持久引用接入后可用于任务"
          type="button"
        >
          <span>知识库</span>
          <strong>{selection.title}</strong>
          <em>暂不可用于任务</em>
        </button>
      ))}
    </section>
  );
}
