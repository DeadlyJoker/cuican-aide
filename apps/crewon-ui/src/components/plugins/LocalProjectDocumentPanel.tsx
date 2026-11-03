import { useMemo, useState } from "react";
import { getDesktopBridge } from "../../lib/desktop/desktopBridge";
import type { DesktopProjectDocumentTarget } from "../../lib/desktop/desktopProjectDocuments";
import { LocalProjectDocumentEditor } from "./LocalProjectDocumentEditor";

const stages = [
  ["brief", "需求"],
  ["script", "剧本"],
  ["bible", "设定"],
  ["shots", "分镜"],
  ["assets", "资产"],
  ["generation", "生成记录"],
  ["qc", "审阅"],
  ["release", "交付"],
] as const;

export function LocalProjectDocumentPanel({
  target,
}: {
  target: Omit<DesktopProjectDocumentTarget, "documentId">;
}) {
  const [documentId, setDocumentId] = useState<string>("script");
  const [dirty, setDirty] = useState(false);
  const documents = getDesktopBridge()?.projectDocuments;
  const identity = JSON.stringify(target);
  const client = useMemo(() => {
    if (!documents) return null;
    const bound = { ...(JSON.parse(identity) as typeof target), documentId };
    return {
      read: () => documents.read(bound),
      save: (value: { content: string; expectedRevision: number }) =>
        documents.save({ ...bound, ...value }),
      subscribe: (changed: () => void) => documents.subscribe(bound, changed),
    };
  }, [documents, identity, documentId]);
  if (!client) return <p role="status">当前客户端不支持本地项目文件。</p>;
  return (
    <section aria-label="本地项目文件" className="min-w-0 overflow-auto">
      <label className="form-field px-4 pt-4">
        项目文档
        <select
          aria-label="项目文档"
          value={documentId}
          disabled={dirty}
          onChange={(event) => setDocumentId(event.target.value)}
        >
          {stages.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <LocalProjectDocumentEditor
        key={documentId}
        client={client}
        title={stages.find(([id]) => id === documentId)?.[1] ?? documentId}
        onDirtyChange={setDirty}
      />
      <p className="px-4 pb-4 text-sm text-muted-foreground">
        与当前项目会话共享本地文件。历史版本自动保留，旧版项目内容仍可从项目页面查看。
      </p>
    </section>
  );
}
