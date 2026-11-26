import { getAgendaDate } from "./agenda-metadata.ts";
import type { Meeting } from "../lib/types.ts";
import type { WorkingGroup } from "../lib/meetings.ts";

// Playlists published by @GraphQLFoundation. A playlist identifies the WG even
// when the recording title contains only a date.
const playlists: Record<WorkingGroup, string> = {
  "graphql-wg": "PLP1igyLx8foH30_sDnEZnxV_8pYW3SDtb",
  "ai-wg": "PLP1igyLx8foHcFyh84YcQOfYQ-kNRbPdi",
  "golden-path-wg": "PLP1igyLx8foH_rlZY638-w_iTFBiKeN_z",
  "graphql-js-wg": "PLP1igyLx8foHghwopNuQM7weyP5jR147I",
  "graphql-over-http": "PLP1igyLx8foEz9127xc0SsabIrbTMt9g5",
  "composite-schemas-wg": "PLP1igyLx8foFjxyTg6wPn4pUkZwuAk2GR",
  "defer-stream-wg": "PLP1igyLx8foHTSNBi4tKUByY5kz4pqz1u",
  "community-wg": "PLP1igyLx8foHhWZk2u1SthsW1weH3VA7l",
  "nullability-wg": "PLP1igyLx8foFPThkIGEUVbne2_DBwgQke",
  "otel-wg": "PLP1igyLx8foFO2xFpWp7IturLnInoyWv1",
  graphiql: "PLP1igyLx8foGJaxw3z0rlUMAuXu7kcsVm",
};

function titleDate(title: string) {
  const iso = title.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (iso) return iso[0];
  const english = title.match(
    /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?) \d{1,2},? \d{4}\b/i,
  );
  if (english) return new Date(english[0] + " UTC").toISOString().slice(0, 10);
}

function playlistItems(
  node: unknown,
  videos: Map<string, Set<string>>,
): string | undefined {
  if (!node || typeof node !== "object") return;
  if ("lockupViewModel" in node || "playlistVideoRenderer" in node) {
    const model = (
      "lockupViewModel" in node
        ? node.lockupViewModel
        : node.playlistVideoRenderer
    ) as {
      contentId?: string;
      videoId?: string;
      metadata?: { lockupMetadataViewModel?: { title?: { content?: string } } };
      title?: { runs?: { text: string }[] };
    };
    const id = model.contentId ?? model.videoId;
    const date = titleDate(
      model.metadata?.lockupMetadataViewModel?.title?.content ??
        model.title?.runs?.map((run) => run.text).join("") ??
        "",
    );
    if (date && id && /^[\w-]{11}$/.test(id)) {
      const ids = videos.get(date) ?? new Set();
      ids.add(id);
      videos.set(date, ids);
    }
    return;
  }
  if ("continuationCommand" in node)
    return (node.continuationCommand as { token?: string }).token;
  let continuation: string | undefined;
  for (const value of Object.values(node))
    continuation = playlistItems(value, videos) ?? continuation;
  return continuation;
}

const nyDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export async function attachMeetingVideos(meetings: Meeting[]) {
  for (const [group, playlist] of Object.entries(playlists)) {
    const byDate = new Map<string, Meeting[]>();
    for (const meeting of meetings.filter(
      (m) => m.group === group && !m.cancelled,
    )) {
      const start = getAgendaDate(meeting.agenda.content);
      const date = start ? nyDate.format(start) : meeting.date;
      const entries = byDate.get(date) ?? [];
      entries.push(meeting);
      byDate.set(date, entries);
    }
    if (!byDate.size) continue;
    try {
      const response = await fetch(
        "https://www.youtube.com/playlist?hl=en&gl=US&list=" + playlist,
        { signal: AbortSignal.timeout(15000) },
      );
      if (!response.ok) throw new Error("HTTP " + response.status);
      const html = await response.text();
      const json = /var ytInitialData\s*=\s*(\{.*?\});\s*<\/script>/s.exec(
        html,
      )?.[1];
      if (!json) throw new Error("Missing playlist metadata");
      const videos = new Map<string, Set<string>>();
      let next = playlistItems(JSON.parse(json).contents, videos);
      const version = /"INNERTUBE_CLIENT_VERSION":"([^"]+)"/.exec(html)?.[1];
      const seen = new Set<string>();
      while (next && version && !seen.has(next)) {
        seen.add(next);
        const page = await fetch("https://www.youtube.com/youtubei/v1/browse", {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: AbortSignal.timeout(15000),
          body: JSON.stringify({
            context: { client: { clientName: "WEB", clientVersion: version } },
            continuation: next,
          }),
        });
        if (!page.ok) {
          console.warn(
            `Incomplete YouTube playlist for ${group}: HTTP ${page.status}`,
          );
          break;
        }
        next = playlistItems(
          (await page.json()).onResponseReceivedActions,
          videos,
        );
      }

      for (const [date, ids] of videos) {
        const matches = byDate.get(date);
        if (matches?.length === 1 && ids.size === 1)
          matches[0].youtubeVideoId = [...ids][0];
      }
    } catch (error) {
      console.warn(`Could not read YouTube playlist for ${group}`, error);
    }
  }
}
