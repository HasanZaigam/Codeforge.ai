import { describe, test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Markdown } from "./Markdown.js";

describe("Markdown", () => {
  test("renders headings, paragraphs, and bullet lists as real elements, not raw text", () => {
    render(<Markdown text={"# Project overview\n\nThis is a paragraph.\n\n- first point\n- second point"} />);
    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent("Project overview");
    expect(screen.getByText("This is a paragraph.").tagName).toBe("P");
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("first point");
  });

  test("renders numbered lists as <ol>, not <ul>", () => {
    const { container } = render(<Markdown text={"1. step one\n2. step two"} />);
    expect(container.querySelector("ol")).toBeTruthy();
    expect(container.querySelector("ul")).toBeNull();
  });

  test("renders bold, italic, and inline code inline within a paragraph", () => {
    render(<Markdown text={"This has **bold**, *italic*, and `inline code`."} />);
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByText("italic").tagName).toBe("EM");
    expect(screen.getByText("inline code").tagName).toBe("CODE");
  });

  test("renders a fenced code block as a real <pre><code> block, preserving content verbatim", () => {
    const { container } = render(<Markdown text={"Run this:\n\n```bash\nnpm install\nnpm test\n```"} />);
    const codeBlock = container.querySelector("pre code");
    expect(codeBlock).toBeTruthy();
    expect(codeBlock?.textContent).toBe("npm install\nnpm test");
  });

  test("renders a markdown link as a real anchor with the correct href and text", () => {
    render(<Markdown text={"See [the docs](https://example.com/docs) for details."} />);
    const link = screen.getByRole("link", { name: "the docs" });
    expect(link).toHaveAttribute("href", "https://example.com/docs");
  });

  test("never renders raw markdown syntax characters as literal text alongside the formatted output", () => {
    render(<Markdown text={"Fixed **add()** to return `a + b`."} />);
    expect(screen.queryByText(/\*\*add/)).toBeNull();
    expect(screen.queryByText(/`a \+ b`/)).toBeNull();
  });

  test("plain, unformatted text still renders correctly as a paragraph (no markdown syntax present)", () => {
    render(<Markdown text="Modified README.md." />);
    expect(screen.getByText("Modified README.md.").tagName).toBe("P");
  });

  test("raw internal event JSON, if it ever slipped through, would render as inert text — never executed or interpreted as HTML", () => {
    const { container } = render(<Markdown text={'{"type":"step_start","sessionID":"ses_123"}'} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain('{"type":"step_start"');
  });
});
