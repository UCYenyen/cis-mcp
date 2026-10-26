const ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#039;": "'",
};

export function decodeEntities(text: string): string {
  return text.replace(/&[#\w]+;/g, (e) => ENTITIES[e] ?? e);
}

/** Strip tags to readable text, turning <br> into spaces and collapsing whitespace. */
export function cellText(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " "),
  ).trim();
}

/** Extract the inner HTML of the first element carrying id="<id>". Shallow but enough for CEdX's flat tables. */
function blockById(html: string, id: string): string | null {
  const start = new RegExp(`<[^>]*\\bid=["']${id}["'][^>]*>`, "i").exec(html);
  if (!start) return null;
  return html.slice(start.index + start[0].length);
}

/**
 * Parse the rows of a <table> (or a <tbody>) into arrays of cell text.
 * Pass the id of the table or tbody; parsing stops at the matching closing tag region
 * heuristically by reading until </table> when a table id is given.
 */
export function parseRows(html: string, opts: { tableId?: string; tbodyId?: string }): string[][] {
  let scope = html;
  if (opts.tableId) {
    const b = blockById(html, opts.tableId);
    if (b == null) return [];
    const end = b.search(/<\/table>/i);
    scope = end >= 0 ? b.slice(0, end) : b;
  }
  if (opts.tbodyId) {
    const b = blockById(scope, opts.tbodyId);
    if (b == null) return [];
    const end = b.search(/<\/tbody>/i);
    scope = end >= 0 ? b.slice(0, end) : b;
  }
  const rows: string[][] = [];
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(scope))) {
    const cells: string[] = [];
    const cellRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(rm[1] ?? ""))) cells.push(cellText(cm[1] ?? ""));
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

/** First capture group of a regex against the HTML, or null. */
export function firstMatch(html: string, re: RegExp): string | null {
  const m = re.exec(html);
  return m ? (m[1] ?? null) : null;
}
