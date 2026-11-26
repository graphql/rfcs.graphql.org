import assert from "node:assert/strict";
import test from "node:test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { noteQuotes } from "../src/sync/note-quotes.ts";

const parser = unified().use(remarkParse);
const mark = (text: string, id = 42) =>
  `<!--BEGIN[graphql/graphql-spec#${id}]-->${text}<!--END[graphql/graphql-spec#${id}]-->`;
const read = (text: string) =>
  noteQuotes(
    text,
    "notes-1",
    (s) => parser.parse(s),
    (urls) =>
      urls
        .filter((url) => url.includes("/pull/"))
        .map((url) => url.split("/").at(-1)!),
    () => [],
  );

test("expand fragments to sentences, sentences to paragraphs, and paragraphs to their heading", () => {
  assert.equal(
    read(
      `First sentence. We discussed ${mark("this")} today. Final sentence.`,
    ).get("42")![0].markdown,
    "We discussed this today.",
  );
  assert.equal(
    read(`First sentence. ${mark("Second sentence")}. Last sentence.`).get(
      "42",
    )![0].markdown,
    "First sentence. Second sentence. Last sentence.",
  );
  const [q] = read(
    `## Decision\n\n${mark("One paragraph.\n\nAnother paragraph.")}`,
  ).get("42")!;
  assert.equal(q.title, "Decision");
  assert.equal(q.markdown, "One paragraph.\n\nAnother paragraph.");
  assert.equal(q.section, "notes-1-1");
});

test("combine highlights per paragraph and resolve nested RFC markers independently", () => {
  const result = read(
    `Context. They ${mark(mark("reviewed", 43))} it and ${mark("agreed")}. More context.`,
  );
  for (const id of ["42", "43"]) {
    const qs = result.get(id)!;
    assert.equal(qs.length, 1);
    const [q] = qs;
    assert.equal(
      q.markdown,
      "Context. They reviewed it and agreed. More context.",
    );
    assert.deepEqual(
      q.highlights.map((r) => q.markdown.slice(r.start, r.end)),
      id === "42" ? ["reviewed", "agreed"] : ["reviewed"],
    );
  }
});

test("a marked heading includes subordinate blocks once, stopping at its next peer", () => {
  const [q, ...rest] = read(
    `## ${mark("Proposal")}\n\nParagraph.\n\n### Detail\n\n- ${mark("An item")}\n\n## Other\n\nUnrelated.`,
  ).get("42")!;
  assert.deepEqual(rest, []);
  assert.equal(
    q.markdown.trimEnd(),
    "## Proposal\n\nParagraph.\n\n### Detail\n\n- An item",
  );
  assert.deepEqual(
    q.highlights.map((r) => q.markdown.slice(r.start, r.end)),
    ["Proposal", "An item"],
  );
});
