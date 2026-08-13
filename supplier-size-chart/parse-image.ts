import { createAnthropic } from "@/lib/anthropic-factory";
import { SONNET_MODEL } from "@/lib/anthropic-client";
import { resolveKey } from "@/lib/api-keys-store";

const PURPOSE = "supplier-size-chart:parse-image";

const PROMPT = `You are reading a garment SIZE CHART from an image.
Return ONLY minified JSON: {"rows": [[header cells...], [row cells...], ...]}
- rows[0] is the header row (e.g. ["Size","Bust (cm)","Length (cm)"]). The first
  column is the size label — call it "Size" if it has no header. Every other
  column is ONE measurement.
- ALWAYS output ONE ROW PER SIZE. If the chart is transposed — the size values
  run ACROSS the top and the attribute/measurement labels (e.g. "US", "EU/CN",
  "Heel to Toe", "Bust") run DOWN the left column, as on many shoe charts — FLIP
  it so each size becomes its own row: rows[0] = ["Size", ...the other attribute
  labels...] with one row per size beneath. Prefer US or letter sizes (S/M/L) as
  the "Size" column, and name that first column for what it is (e.g. "Size (US)").
  The row you pick as the size must appear ONLY as that first column — never also
  as a duplicate column. Do NOT flip a chart that already lists sizes down the
  first column.
- INCLUDE the size column and the measurement columns. DROP any column that is a
  product photo, brand/logo, or decoration, plus title banners and footer/notes
  rows. Never emit an empty column or row.
- CRITICAL: every header must stay aligned with the values directly beneath it.
  When you drop a column, remove its header AND all of its values together —
  NEVER shift a column's numbers under a different column's header.
- Keep size-system columns (EU / UK / US numeric sizes) with a clear header like
  "EU Size" — do not drop the header while keeping the numbers.
- Do NOT invent, rename, or add a measurement that is not in the chart (e.g.
  never output "Trouser Length" unless a real trouser/pant-length column exists).
- Ignore any watermark, logo, checkbox, help icon, or repeated background text
  overlaid on the chart; read the real cell values only.
- Output ALL labels and text in ENGLISH ONLY. Translate any non-English label
  (e.g. Chinese) to the standard English garment term: Size, Bust, Waist, Hip,
  Hipline, Length, Shoulder, Sleeve, Chest, Inseam, Thigh, etc. If a header shows
  both English and another language, keep ONLY the English word. Never output
  Chinese or any other non-Latin characters anywhere in the result.
- Two measurement columns must NEVER share the same name. If preferring the
  English word would collide (e.g. two "Length" or two "Bust" columns), make each
  header unique and specific using the non-English label or the garment it
  belongs to: 衣长 = "Top Length", 裤长 = "Trouser Length", 裙长 = "Skirt Length",
  a top's 胸围 = "Top Bust", a skirt/bottom's = "Skirt Bust". Never leave two
  identical headers.
- Keep the numeric measurements and their units (cm / inch) exactly as written.
  Do not invent, merge, or reorder the measurement columns.
- If the image is not a readable size chart, return {"rows": []}.
No prose, no markdown, JSON only.`;

type Table = { rows: string[][] };

/**
 * Pull every balanced top-level JSON object out of the model's reply.
 *
 * When one image holds several charts (a set's shorts above its top) the model
 * answers with ONE OBJECT PER CHART, separated by a blank line. Slicing from the
 * first "{" to the last "}" turns that into `{…}\n\n{…}` — not valid JSON — so
 * the whole parse failed and a chart the supplier had already sent was lost.
 * Scanning for balanced objects handles both shapes, and prose or a ```json
 * fence around them falls out for free.
 */
function extractJsonObjects(text: string): { objects: Table[]; sawBrace: boolean } {
  const objects: Table[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  let sawBrace = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      sawBrace = true;
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) {
        try {
          objects.push(JSON.parse(text.slice(start, i + 1)) as Table);
        } catch {
          // A single malformed object shouldn't discard the ones that did parse.
        }
        start = -1;
      }
    }
  }
  return { objects, sawBrace };
}

export async function parseChartImage(input: {
  base64: string;
  contentType: string;
}): Promise<{ ok: true; table: Table } | { ok: false; reason: string }> {
  const apiKey = (await resolveKey("ANTHROPIC_API_KEY_ADS")) ?? (await resolveKey("ANTHROPIC_API_KEY"));
  const client = createAnthropic({ apiKey, purpose: PURPOSE, ads: true });

  let text = "";
  try {
    const res = await client.messages.create(
      {
        model: SONNET_MODEL,
        max_tokens: 1500,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: input.contentType as "image/jpeg" | "image/png" | "image/webp", data: input.base64 } },
              { type: "text", text: PROMPT },
            ],
          },
        ],
      },
      { timeout: 120_000 },
    );
    text = (res.content as Array<{ type: string; text?: string }>)
      .map((b) => (b.type === "text" ? b.text ?? "" : ""))
      .join("");
  } catch (e) {
    return { ok: false, reason: `vision-call-failed:${(e as Error).message.slice(0, 120)}` };
  }

  const { objects, sawBrace } = extractJsonObjects(text);
  if (objects.length === 0) return { ok: false, reason: sawBrace ? "bad-json" : "no-json" };
  // Several objects = several charts in the one image. Concatenating their rows
  // reproduces the shape splitChartTables() already cuts apart on the repeated
  // size header, so both reply shapes converge on one code path downstream.
  const parsedRows = objects.flatMap((o) => (Array.isArray(o?.rows) ? o.rows : []));
  if (parsedRows.length < 2) return { ok: false, reason: "empty-table" };
  const rows = parsedRows.map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? "")) : [])).filter((r) => r.length > 0);
  if (rows.length < 2) return { ok: false, reason: "empty-table" };
  return { ok: true, table: { rows } };
}
