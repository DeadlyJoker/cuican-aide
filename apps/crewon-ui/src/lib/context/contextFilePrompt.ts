import type { Locale } from "../i18n";

type ContextFilePromptInput = {
  path: string;
  text: string;
  locale: Locale;
  maxChars?: number;
};

function markdownExcerpt(text: string, locale: Locale, maxChars: number): string {
  const excerpt =
    text.length > maxChars ? `${text.slice(0, maxChars)}\n...` : text;
  return excerpt || (locale === "zh" ? "文件为空" : "Empty file");
}

export function contextFileComposerBlock({
  path,
  text,
  locale,
  maxChars = 2400,
}: ContextFilePromptInput): string {
  return [
    locale === "zh"
      ? `请参考以下工作区上下文文件：${path}`
      : `Use this workspace context file: ${path}`,
    "",
    "```markdown",
    markdownExcerpt(text, locale, maxChars),
    "```",
  ].join("\n");
}

export function contextFileThreadPrompt({
  path,
  text,
  locale,
  maxChars = 6000,
}: ContextFilePromptInput): string {
  return [
    locale === "zh"
      ? `以下工作区文件已由用户从右栏作为上下文发送，请阅读并在后续回答中参考：${path}`
      : `The user sent this workspace file from the right sidebar as context. Read it and use it in follow-up answers: ${path}`,
    "",
    "```markdown",
    markdownExcerpt(text, locale, maxChars),
    "```",
  ].join("\n");
}
