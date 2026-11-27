import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseRelated } from "../src/lib/format.ts";
import { normalizeGithubReferences } from "../src/lib/github.ts";
import { collectMeetings } from "../src/sync/meetings.ts";

const renames = [
  ["facebook/graphql", "graphql/graphql-spec"],
  ["facebook/graphql-spec", "graphql/graphql-spec"],
  ["facebook/graphql-js", "graphql/graphql-js"],
  ["robrichard/defer-stream-wg", "graphql/defer-stream-wg"],
  ["graphql/composite-schemas-spec", "graphql/graphql-federation-spec"],
];

test("normalize legacy repositories in URLs and shorthand references", () => {
  for (const [oldRepo, repo] of renames) {
    for (const suffix of ["/issues/300", "/pull/300", "/discussions/300"]) {
      assert.equal(
        normalizeGithubReferences(`https://github.com/${oldRepo}${suffix}`),
        `https://github.com/${repo}${suffix}`,
      );
    }
    assert.equal(normalizeGithubReferences(`${oldRepo}#300`), `${repo}#300`);
  }
  assert.equal(
    normalizeGithubReferences(
      "https://github.com/Facebook/GraphQL/issues/300#comment",
    ),
    "https://github.com/graphql/graphql-spec/issues/300#comment",
  );
  const unrelated =
    "https://example.com/facebook/graphql/issues/300 facebook/graphql-extra#300 other/graphql#300";
  assert.equal(normalizeGithubReferences(unrelated), unrelated);
});

test("related spec references resolve old URLs and shorthand to the same RFC", () => {
  assert.deepEqual(
    parseRelated(
      "https://github.com/facebook/graphql/issues/300 facebook/graphql-spec#300 graphql/graphql-spec#300",
    ),
    ["300"],
  );
  assert.deepEqual(
    parseRelated("Builds on #12; graphql/graphql-wg#42", "js-"),
    ["js-12", "wg42"],
  );
});

test("meeting links and note markers match canonical RFC URLs while retaining source text", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "rfc-legacy-links-"));
  try {
    const checkout = (group: string) => path.join(root, group);
    const wg = checkout("graphql-wg");
    await mkdir(path.join(wg, "agendas"), { recursive: true });
    await mkdir(path.join(wg, "notes"));
    await writeFile(
      path.join(wg, "agendas/2026-01-01.md"),
      "# Meeting\n\n[Proposal](https://github.com/facebook/graphql/issues/300)",
    );
    const content = renames
      .map(
        ([oldRepo], i) =>
          `<!--BEGIN[${oldRepo}#300]-->Discussion ${i}.<!--END[${oldRepo}#300]-->`,
      )
      .join("\n\n");
    await writeFile(path.join(wg, "notes/2026-01-01.md"), content);
    const meetings = await collectMeetings(checkout, [
      {
        identifier: "300",
        issueUrl: "https://github.com/graphql/graphql-spec/issues/300",
      },
      {
        identifier: "js-300",
        prUrl: "https://github.com/graphql/graphql-js/pull/300",
      },
      {
        identifier: "defer-300",
        wgDiscussionUrl:
          "https://github.com/graphql/defer-stream-wg/discussions/300",
      },
      {
        identifier: "fed-300",
        prUrl: "https://github.com/graphql/graphql-federation-spec/pull/300",
      },
    ]);
    assert.equal(meetings.length, 1);
    const [meeting] = meetings;
    assert.equal(meeting.notes[0].content, content);
    const refs = new Map(
      meeting.references.map((ref) => [ref.identifier, ref]),
    );
    assert.equal(refs.get("300")?.agenda, true);
    assert.equal(refs.get("300")?.quotes?.length, 2);
    for (const id of ["js-300", "defer-300", "fed-300"])
      assert.equal(refs.get(id)?.quotes?.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
