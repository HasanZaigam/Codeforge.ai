import { Fragment, type ReactNode } from "react";

/**
 * Small, dependency-free Markdown renderer — covers exactly what agent
 * output/task summaries actually use (headings, paragraphs, bullet/numbered
 * lists, bold/italic, inline code, fenced code blocks, links). Not a full
 * CommonMark implementation; see /docs/UI_ARCHITECTURE.md for why this is a
 * hand-written subset rather than a dependency (this app's only runtime
 * dependencies are react/react-dom/react-router-dom — see TD-17/TD-20/TD-31
 * for the established pattern of not reaching for a package when a small,
 * well-scoped implementation covers the actual need).
 *
 * Renders to real React elements (never `dangerouslySetInnerHTML`), so all
 * text content is escaped by React itself — this is inherently safe against
 * a task/agent output that happens to contain `<script>`-looking text, since
 * that text is never interpreted as HTML.
 */
export function Markdown({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className="markdown">
      {blocks.map((block, i) => (
        <Fragment key={i}>{renderBlock(block)}</Fragment>
      ))}
    </div>
  );
}

type Block =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "code"; lang: string | null; code: string };

function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (line.trim() === "") {
      i++;
      continue;
    }

    const fence = line.match(/^```\s*(\S*)\s*$/);
    if (fence) {
      const lang = fence[1] || null;
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? "")) {
        codeLines.push(lines[i] ?? "");
        i++;
      }
      i++; // skip closing fence
      blocks.push({ kind: "code", lang, code: codeLines.join("\n") });
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1]!.length as 1 | 2 | 3 | 4 | 5 | 6, text: heading[2]!.trim() });
      i++;
      continue;
    }

    const unorderedMatch = line.match(/^[-*+]\s+(.*)$/);
    const orderedMatch = line.match(/^\d+\.\s+(.*)$/);
    if (unorderedMatch || orderedMatch) {
      const ordered = !!orderedMatch;
      const items: string[] = [(unorderedMatch ?? orderedMatch)![1]!.trim()];
      i++;
      const itemPattern = ordered ? /^\d+\.\s+(.*)$/ : /^[-*+]\s+(.*)$/;
      while (i < lines.length) {
        const next = lines[i] ?? "";
        const m = next.match(itemPattern);
        if (!m) break;
        items.push(m[1]!.trim());
        i++;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    // Paragraph: consecutive plain lines up to a blank line or the start of a new block type.
    const paraLines: string[] = [line.trim()];
    i++;
    while (i < lines.length) {
      const next = lines[i] ?? "";
      if (next.trim() === "" || /^```/.test(next) || /^(#{1,6})\s+/.test(next) || /^[-*+]\s+/.test(next) || /^\d+\.\s+/.test(next)) break;
      paraLines.push(next.trim());
      i++;
    }
    blocks.push({ kind: "paragraph", text: paraLines.join(" ") });
  }

  return blocks;
}

function renderBlock(block: Block): ReactNode {
  switch (block.kind) {
    case "heading": {
      const Tag = `h${Math.min(block.level + 2, 6)}` as keyof JSX.IntrinsicElements; // offset so agent H1s don't outrank the page's own headings
      return <Tag>{renderInline(block.text)}</Tag>;
    }
    case "paragraph":
      return <p>{renderInline(block.text)}</p>;
    case "list": {
      const ListTag = block.ordered ? "ol" : "ul";
      return (
        <ListTag>
          {block.items.map((item, i) => (
            <li key={i}>{renderInline(item)}</li>
          ))}
        </ListTag>
      );
    }
    case "code":
      return (
        <pre className="markdown-code">
          <code>{block.code}</code>
        </pre>
      );
  }
}

// Deliberately asterisk-only for bold/italic (`**bold**`, `*italic*`), not `__bold__`/`_italic_`:
// underscore emphasis is ambiguous around snake_case identifiers/file names/JSON keys (e.g.
// `step_start`, `ses_123`) — exactly the kind of content this renders — a single stray pair of
// underscores across unrelated words would otherwise be misread as an emphasis span. See
// Markdown.test.tsx "raw internal event JSON... would render as inert text".
const INLINE_PATTERN = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

/** Bold/italic/inline-code/link — a single flat pass (no nested emphasis), which covers real agent output without a recursive parser. */
function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;

  for (const match of text.matchAll(INLINE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) nodes.push(text.slice(lastIndex, index));

    const [, code, bold, italic, linkText, linkUrl] = match;
    if (code !== undefined) nodes.push(<code key={key++}>{code}</code>);
    else if (bold !== undefined) nodes.push(<strong key={key++}>{bold}</strong>);
    else if (italic !== undefined) nodes.push(<em key={key++}>{italic}</em>);
    else if (linkText !== undefined && linkUrl !== undefined) {
      nodes.push(
        <a key={key++} href={linkUrl} target="_blank" rel="noreferrer">
          {linkText}
        </a>,
      );
    }

    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}
