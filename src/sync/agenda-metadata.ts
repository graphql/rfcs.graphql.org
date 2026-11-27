// From graphql/wgutils src/agendas/metadata.ts. Replace with the public exports once released.
export function getAgendaDate(contents: string): Date | null {
  const match =
    /https:\/\/www\.timeanddate\.com\/worldclock\/converter\.html\?iso=(\d{8}T\d{6})&/.exec(
      contents,
    );
  if (match) {
    const value = match[1];
    const date = new Date(
      `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`,
    );
    return Number.isNaN(+date) ? null : date;
  }
  // Older agenda templates used this timeanddate URL format.
  const oldMatch =
    /https:\/\/www\.timeanddate\.com\/worldclock\/meetingdetails\.html\?year=(\d+)&month=(\d+)&day=(\d+)&hour=(\d+)&min=(\d+)&/.exec(
      contents,
    );
  if (!oldMatch) return null;
  const [, year, month, day, hour, minute] = oldMatch;
  const date = new Date(
    `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${hour.padStart(2, "0")}:${minute.padStart(2, "0")}:00Z`,
  );
  return Number.isNaN(+date) ? null : date;
}

export function looksLikeItMightHaveBeenCancelled(contents: string): boolean {
  return (
    /\bcancell?ed\b/i.test(contents) ||
    /\bmeeting has been moved\b/i.test(contents) ||
    /\bcall was moved\b/i.test(contents)
  );
}

// The generated filename contains the local meeting day. The timeanddate
// timestamp is UTC and can belong to the preceding local calendar day.
export function getAgendaPathDay(relativePath: string): Date | null {
  const match = /^(\d{4})\/(\d{2})-[^/]+\/(\d{2})-/.exec(relativePath);
  return match
    ? new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]))
    : null;
}
