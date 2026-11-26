import type { Meeting } from "../lib/types.ts";

function section(markdown: string, headings: RegExp): string[] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => headings.test(line));
  if (start < 0) return [];
  const end = lines.findIndex((line, i) => i > start && /^#{1,6}\s/.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

function listedAttendees(markdown: string) {
  const lines = section(
    markdown,
    /^#{1,6}\s+(?:attendees|attendance|participants|present)\s*:?\s*$/i,
  );
  const divider = lines.findIndex((line) =>
    /^\s*\|?\s*:?-{3,}:?\s*\|/.test(line),
  );
  if (divider >= 0) {
    const rows = lines.slice(divider + 1);
    const end = rows.findIndex((line) => !line.includes("|"));
    return rows.slice(0, end < 0 ? undefined : end).filter((line) =>
      line
        .replace(/^\s*\|/, "")
        .split("|")[0]
        .trim(),
    ).length;
  }
  return lines.filter((line) => /^[-*+]\s+\S/.test(line)).length || undefined;
}

function recording(markdown: string) {
  // Meeting templates also contain call invitations, channel links, and playlists.
  const labeled = markdown.matchAll(
    /^(?:[-*#\s]*)(?:\*\*)?(?:(?:meeting|video)\s+)?(?:recording|replay|video)\b[:*\s]*(?:\[[^\]\n]*\]\()?<?(https?:\/\/[^\s)<>\]]+)/gim,
  );
  for (const [, href] of labeled) {
    if (
      /^https?:\/\/(?:(?:www\.)?youtube\.com\/(?:watch\?v=|live\/)|youtu\.be\/|grain\.co\/share\/recording\/|(?:[\w-]+\.)?zoom\.us\/rec\/|(?:www\.)?vimeo\.com\/\d)/i.test(
        href,
      )
    )
      return href;
  }
}

function youtubeId(href: string | undefined) {
  if (!href) return;
  const url = URL.parse(href);
  if (!url) return;
  const id =
    url.hostname === "youtu.be"
      ? url.pathname.slice(1)
      : /^(www\.)?youtube\.com$/.test(url.hostname)
        ? (url.searchParams.get("v") ??
          url.pathname.match(/^\/live\/([^/]+)/)?.[1])
        : undefined;
  return id && /^[\w-]{11}$/.test(id) ? id : undefined;
}

export function meetingDetails(meeting: Meeting) {
  const clean = (markdown: string) => markdown.replace(/<!--[\s\S]*?-->/g, "");
  const agenda = clean(meeting.agenda.content);
  const notes = meeting.notes.map((note) => clean(note.content));
  const actual = notes
    .map(listedAttendees)
    .find((count) => count !== undefined);
  const topics = section(
    agenda,
    /^#{1,6}\s+(?:agenda|agenda items|topics)\s*:?\s*$/i,
  ).filter((line) => /^(?:\d+[.)]|[-*+])\s+\S/.test(line)).length;
  const recordingUrl = [...notes, agenda].map(recording).find(Boolean);
  // Notes sometimes repeat an earlier meeting's recording link.
  const video =
    meeting.youtubeVideoId && meeting.youtubeVideoId !== youtubeId(recordingUrl)
      ? "https://www.youtube.com/watch?v=" + meeting.youtubeVideoId
      : recordingUrl;
  return {
    videoId: youtubeId(video),
    attendees: actual ?? listedAttendees(agenda),
    confirmed: actual !== undefined,
    topics,
    video,
  };
}
