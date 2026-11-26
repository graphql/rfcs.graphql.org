import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { unified } from "unified";
import { groupIds, meetingPaths, type WorkingGroup } from "../lib/meetings.ts";
import type { Meeting, MeetingSource } from "../lib/types.ts";
import {
  getAgendaDate,
  getAgendaPathDay,
  looksLikeItMightHaveBeenCancelled,
} from "./agenda-metadata.ts";

const markdown = unified().use(remarkParse).use(remarkGfm);
const githubLink = /https:\/\/github\.com\/[^\s<>"[`\]()]+/gi;
const fullDate = /\b\d{4}-\d{2}-\d{2}\b/;

function validDate(value: string | undefined): string | undefined {
  if (!value || !fullDate.test(value)) return;
  const parsed = new Date(value);
  if (!Number.isNaN(+parsed) && parsed.toISOString().slice(0, 10) === value)
    return value;
}

function links(content: string): string[] {
  return [...content.matchAll(githubLink)].map(([href]) =>
    href.replace(/[.,;:]+$/, ""),
  );
}

function linkKey(href: string): string {
  return href
    .split(/[?#]/)[0]
    .replace(/\/$/, "")
    .toLowerCase()
    .replace(
      "/graphql/composite-schemas-spec/",
      "/graphql/graphql-federation-spec/",
    )
    .replace(/\/blob\/(?:main|master|[0-9a-f]{40})\//, "/blob/main/")
    .replace(
      /\/(?:pull|issues|discussions)\/(\d+)\/(?:files|commits).*$/,
      "/pull/$1",
    );
}

async function sourceFiles(
  root: string,
  directory: string,
  group: string,
): Promise<MeetingSource[]> {
  const base = path.join(root, directory);
  const entries = await readdir(base, {
    recursive: true,
    withFileTypes: true,
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const files = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        /\.md$/i.test(entry.name) &&
        !/^(readme|(?:agenda[-_])?[-_]?template)\.md$/i.test(entry.name),
    )
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
  return Promise.all(
    files.map(async (file) => ({
      href: `https://github.com/graphql/${group}/blob/main/${path.relative(root, file).split(path.sep).map(encodeURIComponent).join("/")}`,
      content: await readFile(file, "utf8"),
    })),
  );
}

function agendaDate(source: MeetingSource): string | undefined {
  const file = decodeURIComponent(source.href.split("/agendas/").at(-1)!);
  return (
    getAgendaPathDay(file)?.toISOString().slice(0, 10) ??
    validDate(fullDate.exec(path.basename(file))?.[0]) ??
    getAgendaDate(source.content)?.toISOString().slice(0, 10)
  );
}

function noteParts(
  source: MeetingSource,
): { source: MeetingSource; date?: string; month?: string }[] {
  const filename = decodeURIComponent(source.href.split("/").at(-1)!);
  const date = fullDate.exec(filename)?.[0];
  if (date) return [{ source, date }];
  const month = /\b\d{4}-\d{2}\b/.exec(filename)?.[0];
  const headings = markdown.parse(source.content).children.flatMap((node) => {
    if (node.type !== "heading" || !node.position) return [];
    const label = source.content.slice(
      node.position.start.offset,
      node.position.end.offset,
    );
    const date = fullDate.exec(label)?.[0];
    return date ? [{ date, start: node.position.start.offset! }] : [];
  });
  if (!headings.length) return [{ source, month }];
  const intro = source.content.slice(0, headings[0].start);
  return headings.map(({ date, start }, index) => ({
    source: {
      ...source,
      content: intro + source.content.slice(start, headings[index + 1]?.start),
    },
    date,
    month,
  }));
}

function nodeLinks(node: object, definitions: boolean): string[] {
  const type = "type" in node ? node.type : undefined;
  if (type === "code" || type === "inlineCode" || type === "html") return [];
  if (
    "url" in node &&
    typeof node.url === "string" &&
    (type === "link" || (definitions && type === "definition"))
  )
    return [node.url];
  if ("value" in node && type === "text" && typeof node.value === "string")
    return links(node.value);
  return "children" in node && Array.isArray(node.children)
    ? node.children.flatMap((child: object) => nodeLinks(child, definitions))
    : [];
}

type RfcSource = {
  identifier: string;
  sourceUrls?: Set<string>;
  issueUrl?: string;
  prUrl?: string;
  wgDiscussionUrl?: string;
  rfcDocUrl?: string;
};

export async function collectMeetings(
  checkout: (group: WorkingGroup) => string,
  records: Iterable<RfcSource>,
): Promise<Meeting[]> {
  const identifiers = new Map<string, Set<string>>();
  for (const record of records) {
    for (const href of [
      ...(record.sourceUrls ?? []),
      record.issueUrl,
      record.prUrl,
      record.wgDiscussionUrl,
      record.rfcDocUrl,
    ]) {
      if (!href) continue;
      const key = linkKey(href);
      const matches = identifiers.get(key) ?? new Set();
      matches.add(record.identifier);
      identifiers.set(key, matches);
    }
  }
  const match = (urls: string[]) =>
    urls.flatMap((href) => {
      const identifier = identifiers.get(linkKey(href));
      return identifier ? [...identifier] : [];
    });

  const groups = await Promise.all(
    groupIds.map(async (group) => {
      const paths = meetingPaths(group);
      const [agendas, notes] = await Promise.all([
        sourceFiles(checkout(group), paths.agendas, group),
        sourceFiles(checkout(group), paths.notes, group),
      ]);
      const meetings: Meeting[] = [];
      const byAgenda = new Map<string, Meeting>();
      for (const agenda of agendas) {
        const date = agendaDate(agenda);
        if (!date) {
          console.warn(`No meeting date for ${agenda.href}`);
          continue;
        }
        const id = meetings.some((meeting) => meeting.date === date)
          ? `${date}-${decodeURIComponent(agenda.href.split("/").at(-1)!)
              .replace(/\.md$/i, "")
              .replace(/[^\w.-]/g, "-")}`
          : date;
        const meeting: Meeting = {
          id,
          date,
          group,
          agenda,
          notes: [],
          cancelled: looksLikeItMightHaveBeenCancelled(agenda.content),
          references: [
            ...new Set(match(nodeLinks(markdown.parse(agenda.content), true))),
          ].map((identifier) => ({ identifier, agenda: true })),
        };
        meetings.push(meeting);
        byAgenda.set(linkKey(agenda.href), meeting);
      }
      for (const note of notes) {
        for (const part of noteParts(note)) {
          const agendaDeclarations = part.source.content.matchAll(
            /^(?:[-*] )?(?:\*\*)?(?:\[Agenda\]\([^\n]+|Agenda(?:\*\*)?:[^\n]*(?:\n[^\n]+)?)/gim,
          );
          const agendaLinks = [...agendaDeclarations].flatMap(([declaration]) =>
            links(declaration),
          );
          const linked = [
            ...new Set(
              agendaLinks.flatMap((href) => {
                const meeting = byAgenda.get(linkKey(href));
                return meeting ? [meeting] : [];
              }),
            ),
          ];
          const candidates = linked.length
            ? linked
            : meetings.filter((meeting) =>
                part.date
                  ? meeting.date === part.date
                  : !meeting.cancelled &&
                    part.month &&
                    meeting.date.startsWith(part.month),
              );
          if (candidates.length === 1) candidates[0].notes.push(part.source);
          else
            console.warn(
              `Unresolved notes ${note.href}${part.date ? ` (${part.date})` : ""}`,
            );
        }
      }
      for (const meeting of meetings) {
        meeting.notes.sort(
          (a, b) =>
            Number(a.href.includes("/summary-")) -
            Number(b.href.includes("/summary-")),
        );
        const references = new Map(
          meeting.references.map((ref) => [ref.identifier, ref]),
        );
        meeting.notes.forEach((note, index) => {
          note.section = `notes-${index + 1}`;
          if (meeting.cancelled) return;
          let section = note.section;
          let excludedDepth = 7;
          for (const node of markdown.parse(note.content).children) {
            if (node.type === "heading") {
              section = `${note.section}-${node.position!.start.line}`;
              if (node.depth <= excludedDepth) {
                const title = note.content.slice(
                  node.position?.start.offset,
                  node.position?.end.offset,
                );
                excludedDepth =
                  /\b(next steps|action items|follow[- ]ups)\b/i.test(title)
                    ? node.depth
                    : 7;
              }
            }
            if (excludedDepth < 7) continue;
            for (const identifier of match(nodeLinks(node, false))) {
              if (!references.get(identifier)?.section)
                references.set(identifier, {
                  ...references.get(identifier),
                  identifier,
                  section,
                });
            }
          }
        });
        meeting.references = [...references.values()];
      }
      return meetings;
    }),
  );
  return groups
    .flat()
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.group.localeCompare(b.group) ||
        a.id.localeCompare(b.id),
    );
}
