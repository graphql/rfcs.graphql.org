import type { Nodes, Root } from "mdast";
import type { NoteQuote } from "../lib/types.ts";

type Range = { start: number; end: number };
type Mark = Range & { key: string };
type Block = Range & {
  node: Nodes;
  heading?: number;
  section: string;
  title?: string;
};

const withoutFinalPunctuation = (text: string) =>
  text.trim().replace(/[.!?]+$/, "");
const sentences = new Intl.Segmenter("en", { granularity: "sentence" });
const intersects = (a: Range, b: Range) => a.start < b.end && b.start < a.end;

// Keep positions in the marker-free Markdown. Removing inline comments leaves
// line numbers intact for links back to the original meeting notes.
function annotatedSource(source: string) {
  let markdown = "",
    offset = 0;
  const marks: Mark[] = [];
  const open = new Map<string, number[]>();
  for (const marker of source.matchAll(
    /<!--\s*(BEGIN|END)\[([\w.-]+\/[\w.-]+#\d+)\]\s*-->/gi,
  )) {
    markdown += source.slice(offset, marker.index);
    offset = marker.index + marker[0].length;
    const key = marker[2].toLowerCase();
    const stack = open.get(key) ?? [];
    if (marker[1].toUpperCase() === "BEGIN") {
      stack.push(markdown.length);
      open.set(key, stack);
    } else {
      const start = stack.pop();
      if (start !== undefined && start < markdown.length)
        marks.push({ key, start, end: markdown.length });
    }
  }
  return { markdown: markdown + source.slice(offset), marks };
}

export function noteQuotes(
  source: string,
  section: string,
  parse: (text: string) => Root,
  match: (urls: string[]) => string[],
  links: (node: Nodes) => string[],
) {
  const { markdown, marks } = annotatedSource(source);
  const blocks: Block[] = [];
  let anchor = section,
    title: string | undefined;
  function visit(node: Nodes) {
    const start = node.position?.start.offset,
      end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    if (node.type === "heading") {
      anchor = section + "-" + node.position!.start.line;
      title = markdown
        .slice(start, end)
        .replace(/^#{1,6}\s+/, "")
        .trim();
      blocks.push({
        start,
        end,
        node,
        heading: node.depth,
        section: anchor,
        title,
      });
    } else if (
      node.type === "paragraph" ||
      node.type === "code" ||
      node.type === "table"
    ) {
      blocks.push({ start, end, node, section: anchor, title });
    } else if ("children" in node) node.children.forEach(visit);
  }
  visit(parse(markdown));
  const byRfc = new Map<string, Range[]>();
  for (const mark of marks) {
    const [repo, number] = mark.key.split("#");
    for (const id of match(
      ["pull", "issues", "discussions"].map(
        (kind) => `https://github.com/${repo}/${kind}/${number}`,
      ),
    )) {
      const ranges = byRfc.get(id) ?? [];
      ranges.push(mark);
      byRfc.set(id, ranges);
    }
  }
  const result = new Map<string, NoteQuote[]>();
  for (const [i, block] of blocks.entries()) {
    const linked = new Set(match(links(block.node)));
    const markedPassages = new Set(
      marks
        .filter((mark) => intersects(mark, block))
        .map((mark) => mark.start + ":" + mark.end),
    );
    for (const [id, ranges] of byRfc)
      if (ranges.some((r) => intersects(r, block))) linked.add(id);
    for (const id of linked) {
      const all = byRfc.get(id) ?? [];
      const hits = all.filter((r) => intersects(r, block));
      let { start, end } = block;
      let caption: string | undefined;
      if (block.heading) {
        end =
          blocks
            .slice(i + 1)
            .find((b) => b.heading && b.heading <= block.heading!)?.start ??
          markdown.length;
      } else if (hits.length === 1 && markedPassages.size === 1) {
        const hit = hits[0];
        const raw = markdown.slice(start, end);
        const marked = markdown
          .slice(Math.max(start, hit.start), Math.min(end, hit.end))
          .trim();
        if (withoutFinalPunctuation(raw) === withoutFinalPunctuation(marked))
          caption = block.title;
        else {
          const parts = [...sentences.segment(raw)].filter((s) =>
            intersects(hit, {
              start: start + s.index,
              end: start + s.index + s.segment.length,
            }),
          );
          if (
            parts.length === 1 &&
            withoutFinalPunctuation(parts[0].segment) !==
              withoutFinalPunctuation(marked)
          ) {
            start += parts[0].index;
            end = start + parts[0].segment.trimEnd().length;
          }
        }
      }
      const quotes = result.get(id) ?? [];
      // A marked heading already includes its subordinate headings and paragraphs.
      if (
        quotes.some(
          (q) => q.start <= start && q.start + q.markdown.length >= end,
        )
      )
        continue;
      const last = quotes.at(-1);
      // Keep paragraphs spanned by one marker in the same quotation.
      if (
        last &&
        hits.some(
          (r) =>
            intersects(r, {
              start: last.start,
              end: last.start + last.markdown.length,
            }) && intersects(r, block),
        ) &&
        last.section === block.section
      ) {
        start = last.start;
        caption = last.title;
        quotes.pop();
      }
      const highlights = all
        .filter((r) => intersects(r, { start, end }))
        .map((r) => ({
          start: Math.max(start, r.start) - start,
          end: Math.min(end, r.end) - start,
        }));
      quotes.push({
        start,
        markdown: markdown.slice(start, end),
        highlights,
        title: caption,
        section: block.section,
      });
      result.set(id, quotes);
    }
  }
  return result;
}
