import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";

type Document = Readonly<{ content: string; revision: number; digest: string }>;
/** The host binds project and document identity; the renderer receives no filesystem path. */
export type LocalProjectDocumentClient = Readonly<{
  read(): Promise<Document | null>;
  save(input: { content: string; expectedRevision: number }): Promise<Document>;
  subscribe(changed: () => void): Promise<() => void>;
}>;

export function LocalProjectDocumentEditor({
  client,
  title,
  onDirtyChange,
}: {
  client: LocalProjectDocumentClient;
  title: string;
  onDirtyChange?(dirty: boolean): void;
}) {
  const [document, setDocument] = useState<Document | null>(null);
  const [content, setContent] = useState("");
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  const dirty = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    dirty.current = false;
    onDirtyChange?.(false);
    setReady(false);
    setSaving(false);
    setContent("");
    setDocument(null);
    setNotice("");
    async function refresh() {
      if (dirty.current) {
        setNotice("文件已有新版本，你的草稿已保留。请另存草稿后重新读取。");
        return;
      }
      const request = ++generation.current;
      try {
        const next = await client.read();
        if (!active || request !== generation.current || dirty.current) return;
        setDocument(next);
        setContent(next?.content ?? "");
        setReady(true);
      } catch (error) {
        if (active) setNotice(documentError(error));
      }
    }
    // Subscribe before the first read so no committed update is lost between them.
    void client
      .subscribe(() => {
        void refresh();
      })
      .then((stop) => {
        if (!active) {
          stop();
          return;
        }
        unsubscribe = stop;
        void refresh();
      })
      .catch((error) => {
        if (active) setNotice(documentError(error));
      });
    return () => {
      active = false;
      ++generation.current;
      unsubscribe?.();
    };
  }, [client, reload, onDirtyChange]);

  async function save() {
    if (!ready || saving) return;
    const request = generation.current;
    const submitted = content;
    setSaving(true);
    try {
      const next = await client.save({
        content: submitted,
        expectedRevision: document?.revision ?? 0,
      });
      if (request !== generation.current) return;
      setDocument(next);
      dirty.current = false;
      onDirtyChange?.(false);
      setNotice("已保存到项目文件。");
    } catch {
      if (request === generation.current)
        setNotice("保存未完成或版本已变化，草稿已保留。重新读取前请保留草稿。");
    } finally {
      if (request === generation.current) setSaving(false);
    }
  }
  return (
    <section className="grid min-w-0 gap-3 p-4" aria-label={title}>
      <label className="form-field">
        {title}
        <textarea
          className="min-h-64 w-full resize-y"
          aria-label={title}
          value={content}
          disabled={!ready || saving}
          onChange={(event) => {
            dirty.current = true;
            onDirtyChange?.(true);
            setContent(event.target.value);
          }}
        />
      </label>
      <Button
        type="button"
        disabled={!ready || saving || !dirty.current}
        onClick={() => void save()}
      >
        {saving ? "保存中…" : "保存"}
      </Button>
      <Button
        variant="outline"
        type="button"
        disabled={saving}
        onClick={() => setReload((value) => value + 1)}
      >
        {dirty.current ? "放弃草稿并读取最新版本" : "重新读取"}
      </Button>
      <p role="status">{notice}</p>
    </section>
  );
}

function documentError(error: unknown) {
  if (
    error instanceof Error &&
    error.message.includes("project_document_workspace_required")
  )
    return "此项目会话尚未绑定本地工作空间。请先选择项目文件夹，再新建项目会话。原有内容仍保留在项目页面。";
  return "无法读取项目文件，请检查连接与访问权限。";
}
