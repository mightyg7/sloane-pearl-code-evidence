import { createAnthropic } from "@/lib/anthropic-factory";
import { trackUsage, estimateAnthropicCost } from "./usage-tracker";
import { callGeminiVertexText, GEMINI_VERTEX_MODEL } from "@/lib/vertex-provider";

function getClient(apiKey: string): ReturnType<typeof createAnthropic> {
  return createAnthropic({ apiKey, purpose: "product-enhance" });
}

// Combined enhance + variant-translation in a single Sonnet call. Replaces
// the two serial calls (enhanceProduct + translateVariants) used by the v2
// import flow. The system prompt is intentionally padded with few-shot
// examples so the stable prefix exceeds Sonnet's 1024-token prompt-cache
// minimum — within a batch (fixed language+gender) products 2..N read the
// cached prefix and their TTFT drops sharply.
export async function enhanceAndTranslate(
  apiKey: string,
  opts: {
    title: string;
    description: string;
    language?: string;
    gender?: "women" | "men" | "unisex";
    usedNames?: string[];
    variants?: Array<{
      option1?: string | null;
      option2?: string | null;
      option3?: string | null;
    }>;
    optionNames?: string[];
    // Anthropic model id (e.g. "claude-haiku-4-5-20251001"). Defaults to
    // Sonnet 4.5 when omitted — that's what this function was originally
    // pinned to, and the prompt-cache / few-shot padding is tuned for it.
    model?: string;
    /**
     * When set, the AI does NOT pick a first name — it MUST use this
     * exact name for all entries in the `names[]` array (with
     * different descriptors after the |). Sourced from the per-market
     * NamePool picker in `@/lib/name-pools/picker`. The pool gives us
     * a market-native, collision-free name; the AI's only job becomes
     * writing the descriptors / hero description / bullets.
     */
    chosenFirstName?: string;
    /**
     * LLM provider for this call. Defaults to "anthropic" (unchanged
     * behavior for every existing caller). "vertex" routes the exact
     * same prompt through Gemini via Vertex AI instead — scoped, additive,
     * used only where a caller explicitly opts in (see
     * src/lib/filler-import/run-collection-import.ts for the one
     * Sloane & Pearl-scoped call site).
     */
    provider?: "anthropic" | "vertex";
  }
): Promise<{
  names: Array<{ name: string; available: boolean }>;
  heroDescription: string;
  bulletHeader: string;
  bullets: string[];
  closingLine: string;
  /** Canonical singular garment noun (e.g. "Sandals", "Midi Dress"), derived
   *  from the same inputs as the name so title and type never disagree. Used as
   *  Shopify product_type and the authoritative noun for UGC scripts. */
  productType: string;
  variantTranslations?: {
    options: Array<{
      originalName: string;
      translatedName: string;
      values: Record<string, string>;
    }>;
  };
  usage?: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    cost: number;
  };
}> {
  const client = getClient(apiKey);
  const lang = opts.language || "English";

  // Collect unique option values per option index from the variants array,
  // same shape the legacy translateVariants helper used.
  const optionMap: Record<string, Set<string>> = {};
  for (const v of opts.variants || []) {
    if (v.option1) (optionMap["option1"] ||= new Set()).add(v.option1);
    if (v.option2) (optionMap["option2"] ||= new Set()).add(v.option2);
    if (v.option3) (optionMap["option3"] ||= new Set()).add(v.option3);
  }
  const optionNameMap: Record<string, string> = {};
  if (opts.optionNames) {
    opts.optionNames.forEach((name, i) => {
      optionNameMap[`option${i + 1}`] = name;
    });
  }
  const optionsToTranslate = Object.entries(optionMap).map(([key, values]) => ({
    key,
    name: optionNameMap[key] || key,
    values: Array.from(values),
  }));
  const needsTranslation = optionsToTranslate.length > 0;

  // Stable system prompt — depends only on (language, gender). Within a batch
  // these are constant, so products 2..N hit the prompt cache.
  const systemPrompt = `You are a creative product copywriter AND localization editor for a modern, elegant fashion brand. Write in ${lang}.

Your task has TWO parts:
(A) ENHANCE: given a product title and description, write compelling enhanced copy.
(B) TRANSLATE: given a list of variant option names and values, translate them into ${lang}.

=====  PART A — ENHANCE  =====

Naming rules:
- This is a ${opts.gender === "men" ? "MEN'S" : opts.gender === "women" ? "WOMEN'S" : "UNISEX"} product collection. ALL first names MUST be ${opts.gender === "men" ? "MASCULINE (e.g. Hugo, Lucas, Théo, Marco, Raphaël, Matteo, Santiago)" : opts.gender === "women" ? "FEMININE (e.g. Margot, Chloé, Léa, Camille, Sofia, Valentina)" : "UNISEX (e.g. Alex, Sam, Jordan, Quinn)"}. Do NOT use ${opts.gender === "men" ? "feminine" : opts.gender === "women" ? "masculine" : "gendered"} names.
- Each product in a collection MUST have a unique first name. Never repeat a first name.
- A list of FORBIDDEN NAMES may appear in the user message — every name you return MUST differ from that list. Hard constraint.
- The first entry in "names" should always be the best/preferred option.

Name format: [First Name] | [Key Descriptors + Garment Type]
Bullets format: [Feature]: [Benefit]
All text must be in ${lang}.
Product names appear inside a gendered navigation menu (under "Women" or "Men"). Do NOT include gender words like "Women's"/"Men's"/"para Hombre"/"para Mujer"/"Donna"/"Uomo"/"Damen"/"Herren"/"Femme"/"Homme" in the name — gender is already clear from context. Keep names SHORT (max 6 words after the |).
NEVER reference the source/original brand name, store name, or any trademarked names (e.g. "Bloom™", "Amsterdam", etc.). The generated first name IS the brand — use it in the description and closing line instead. Example: if the name is "Théo | Gorra Denim", refer to it as "the Théo cap" not "the Bloom™ cap".

=====  PART B — TRANSLATE  =====

If the user message includes a "VARIANT OPTIONS" block:
- Return "variantTranslations.options[]" covering every option in that block.
- "translatedName" must be the proper ${lang} name for the option (e.g. "Kleur" → "Color", "Maat" → "Talla", "Size" → "Talla", "Couleur" → "Color").
- Do NOT literally translate "option1"/"option2" — use the "name" field provided to determine the real option name.
- Inside "values", map each original value to its ${lang} translation. If the value is already in ${lang} (or is a universal token like a numeric size, "XL", "M"), repeat it unchanged.

Completeness is mandatory:
- For every option in VARIANT OPTIONS, return one entry in "options[]" with a non-empty "translatedName" in ${lang}.
- For every value listed under that option, return one key in "values" whose translation is a real word in ${lang}.
- Never emit the literal placeholder strings shown in the schema (e.g. "<...>"), never an empty string, never null. Echoing the source value is only acceptable for universal tokens (numeric sizes, "M"/"L"/"XL"/etc.).

If the user message does NOT include a "VARIANT OPTIONS" block, omit "variantTranslations" entirely.

=====  OUTPUT FORMAT  =====

Return ONLY valid JSON. No markdown fences, no prose before or after. Shape:

{
  "names": ["Name | Descriptors in ${lang}", "Name | Alt Descriptors", "Name | Alt Descriptors"],
  "heroDescription": "A compelling 1-2 sentence description",
  "bulletHeader": "Why You'll Love It",
  "bullets": ["Feature 1: Benefit 1", "Feature 2: Benefit 2", "Feature 3: Benefit 3", "Feature 4: Benefit 4", "Feature 5: Benefit 5"],
  "closingLine": "A closing sentence mentioning the product",
  "productType": "<the canonical product category as a SHORT singular noun in ${lang}, e.g. Sandals, Heeled Sandals, Sneakers, Midi Dress, Blouse, Jacket. Base it on what the product ACTUALLY is from the title + description — this is the word a real customer would call it. NOT a brand, NOT a person's name, NOT marketing adjectives.>",
  "variantTranslations": { "options": [{ "originalName": "option1", "translatedName": "<option name in ${lang}>", "values": { "<original_value>": "<translated value in ${lang}>" } }] }
}

=====  EXAMPLE (reference only — illustrates a DIFFERENT language pair than your target. Do NOT copy these names or translations verbatim; translate into ${lang}.)  =====

User: Product title: Strickjacke aus Baumwolle
Description: Schwere Strickjacke mit Kängurutasche.
VARIANT OPTIONS: [{"key":"option1","name":"Farbe","values":["Schwarz","Grau","Beige"]},{"key":"option2","name":"Größe","values":["M","L"]}]

Assistant (target language for this example is French, illustrating that EVERY option name and EVERY value is fully resolved — no placeholders, no empty strings):
{
  "names": ["${opts.gender === "men" ? "Théo" : opts.gender === "women" ? "Margot" : "Alex"} | Cardigan Maille Épaisse", "Alt | Pull Boutonné Confort", "Alt | Cardigan Décontracté Weekend"],
  "heroDescription": "Un cardigan en maille épaisse pensé pour les matins frais et les week-ends tranquilles.",
  "bulletHeader": "Pourquoi vous allez l'adorer",
  "bullets": ["Maille épaisse : garde sa forme lavage après lavage", "Poche kangourou : les mains au chaud à la demande", "Coupe ample : se superpose facilement sur un t-shirt", "Mélange riche en coton : doux sur la peau", "Poignets et ourlet côtelés : reste en place toute la journée"],
  "closingLine": "À porter partout où le froid peut vous trouver.",
  "productType": "Cardigan",
  "variantTranslations": { "options": [{ "originalName": "option1", "translatedName": "Couleur", "values": { "Schwarz": "Noir", "Grau": "Gris", "Beige": "Beige" } }, { "originalName": "option2", "translatedName": "Taille", "values": { "M": "M", "L": "L" } }] }
}`;

  // chosenFirstName supersedes the system-prompt naming rules. We
  // keep the system prompt unchanged (so the prompt cache stays warm
  // across the batch) and inject the override at the top of the user
  // message — model attention reliably picks up imperative
  // user-message instructions over the cached system rules.
  const chosenNameBlock = opts.chosenFirstName
    ? `USE THIS EXACT FIRST NAME: "${opts.chosenFirstName}"\nThis instruction supersedes the gender-anchor and forbidden-names rules in the system prompt. Every entry in the "names" array MUST start with "${opts.chosenFirstName} | " and only differ in the descriptors after the pipe. Do NOT pick a different name.\n\n`
    : "";
  const forbiddenBlock =
    opts.chosenFirstName || !opts.usedNames?.length
      ? ""
      : `FORBIDDEN NAMES (already used in this batch — do NOT reuse any): ${opts.usedNames.join(", ")}\n\n`;
  const variantBlock = needsTranslation
    ? `VARIANT OPTIONS: ${JSON.stringify(optionsToTranslate)}\n\n`
    : "";

  const userContent = `${chosenNameBlock}${forbiddenBlock}${variantBlock}Product title: ${opts.title}\nDescription: ${opts.description || "No description available"}`;

  let text: string;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheWrite = 0;
  let cacheRead = 0;
  const model = opts.model || "claude-sonnet-4-6";
  if (opts.provider === "vertex") {
    // Gemini via Vertex AI — a Google Cloud product, not the plain Gemini
    // Developer API key used elsewhere in this codebase. See
    // src/lib/vertex-provider.ts. No prompt caching on this path (Vertex
    // handles it differently); volume here is low so the cost is negligible.
    const vertexResult = await callGeminiVertexText({
      system: systemPrompt,
      user: userContent,
      purpose: "product-enhancement-merged",
    });
    text = vertexResult.text;
    inputTokens = vertexResult.inputTokens;
    outputTokens = vertexResult.outputTokens;
  } else {
    const response = await client.messages.create({
      model,
      max_tokens: 2048,
      system: [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: userContent }],
    });

    const usage = response.usage as {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    inputTokens = usage?.input_tokens || 0;
    outputTokens = usage?.output_tokens || 0;
    cacheWrite = usage?.cache_creation_input_tokens || 0;
    cacheRead = usage?.cache_read_input_tokens || 0;

    try {
      if (cacheWrite || cacheRead) {
        console.log(
          `[enhance+translate] cache_write=${cacheWrite} cache_read=${cacheRead} in=${inputTokens} out=${outputTokens}`
        );
      }
      await trackUsage({
        provider: "anthropic",
        model,
        inputTokens: inputTokens + cacheWrite + cacheRead,
        outputTokens,
        cost: estimateAnthropicCost(inputTokens, outputTokens, model),
        purpose: "product-enhancement-merged",
      });
    } catch {}

    text =
      response.content[0].type === "text" ? response.content[0].text : "";
  }

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Failed to parse AI response");
  const parsed = JSON.parse(jsonMatch[0]);

  const usedSet = new Set(
    (opts.usedNames || []).map((n) => n.toLowerCase())
  );
  let rawNames: string[] = Array.isArray(parsed.names) ? parsed.names : [];
  let heroDescription: string = parsed.heroDescription || "";
  let closingLine: string = parsed.closingLine || "";
  let bullets: string[] = Array.isArray(parsed.bullets) ? parsed.bullets : [];

  // Server-side enforcement of chosenFirstName. The model is unreliable
  // about following the per-call override — the cached system-prompt
  // anchors (Margot/Camille/Sofia/…) leak into both names[] and the body
  // copy. See enforceChosenFirstName for the two-sweep guard that handles
  // both "AI used wrong name in names[]" and "AI complied for names[] but
  // leaked a different name into hero/closing".
  if (opts.chosenFirstName) {
    const enforced = enforceChosenFirstName({
      rawNames,
      heroDescription,
      closingLine,
      bullets,
      chosenFirstName: opts.chosenFirstName,
    });
    rawNames = enforced.rawNames;
    heroDescription = enforced.heroDescription;
    closingLine = enforced.closingLine;
    bullets = enforced.bullets;
    if (enforced.swept.fromAlternatives.length || enforced.swept.fromPattern.length) {
      console.log(
        `[enhance+translate] override-applied: pool="${opts.chosenFirstName}" ` +
          `alt=[${enforced.swept.fromAlternatives.join(",")}] ` +
          `pattern=[${enforced.swept.fromPattern.join(",")}]`,
      );
    }
  }

  const names = rawNames.map((name: string) => {
    const firstName = name.split("|")[0].trim();
    const isUsed = usedSet.has(firstName.toLowerCase());
    return { name, available: !isUsed };
  });

  return {
    names,
    heroDescription,
    bulletHeader: parsed.bulletHeader || "Why You'll Love It",
    bullets,
    closingLine,
    productType: typeof parsed.productType === "string" ? parsed.productType.trim() : "",
    variantTranslations: parsed.variantTranslations,
    usage: {
      model: opts.provider === "vertex" ? GEMINI_VERTEX_MODEL : model,
      inputTokens,
      outputTokens,
      cacheWriteTokens: cacheWrite,
      cacheReadTokens: cacheRead,
      cost:
        opts.provider === "vertex"
          ? 0
          : estimateAnthropicCost(inputTokens, outputTokens, model),
    },
  };
}

/**
 * Force the first-name segment of every "[Name] | [Descriptors]"
 * entry to be exactly `chosenFirstName`. AI's descriptors are kept;
 * only the brand name is overridden. Used as a bulletproof guard
 * against the model ignoring the per-call override.
 */
export function forceFirstName(names: string[], chosenFirstName: string): string[] {
  return names.map((entry) => {
    if (typeof entry !== "string") return `${chosenFirstName} | `;
    const pipeIdx = entry.indexOf("|");
    const descriptor = pipeIdx === -1 ? entry.trim() : entry.slice(pipeIdx + 1).trim();
    return `${chosenFirstName} | ${descriptor}`;
  });
}

/**
 * Pull the first-name token out of an AI-generated name like
 * "Camille | Striped Midi Dress". Returns "" when the input is
 * unusable.
 */
export function extractFirstNameToken(entry: unknown): string {
  if (typeof entry !== "string") return "";
  const pipeIdx = entry.indexOf("|");
  const head = pipeIdx === -1 ? entry : entry.slice(0, pipeIdx);
  return head.trim().split(/\s+/)[0] || "";
}

/**
 * Replace whole-word occurrences of `from` with `to` in `text`. Used
 * to update heroDescription / closingLine when we override the AI's
 * picked first-name — the AI tends to mention the name a couple of
 * times ("the Camille top is …", "Wear it anywhere — Camille has
 * you covered."). Whole-word matching avoids clobbering substrings
 * that happen to share the name's prefix.
 */
export function replaceNameToken(text: string, from: string, to: string): string {
  if (!text || !from) return text;
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Unicode-aware "whole word" boundary. The default \b only treats ASCII
  // letters/digits/underscore as word characters, so /\bÉlise\b/ never
  // matches at word start (the space-to-É transition isn't a boundary in
  // ASCII mode). Names in our naming pools and the AI's anchor list
  // routinely contain accented letters (Élise, Léa, Aurélie, Céleste, …),
  // so we anchor with \p{L} lookarounds instead.
  const re = new RegExp(`(?<!\\p{L})${escaped}(?!\\p{L})`, "gu");
  return text.replace(re, to);
}

/**
 * Garment / accessory nouns the AI consistently emits after "the {Name}"
 * in heroDescription / closingLine. Derived from the prompt's
 * "[First Name] | [Key Descriptors + Garment Type]" output style — every
 * description we've observed follows "the {Name} {garment}" phrasing.
 */
const ENFORCE_GARMENT_NOUNS = [
  "blouse", "dress", "skirt", "pants", "top", "shirt", "jacket", "coat",
  "sweater", "cardigan", "jumpsuit", "romper", "blazer", "polo", "hoodie",
  "tee", "cap", "pump", "pumps", "flat", "flats", "shoe", "shoes", "sandal",
  "sandals", "boot", "boots", "sneaker", "sneakers", "bag", "necklace",
  "earrings", "bracelet", "ring", "scarf", "belt", "hat", "watch", "set",
  "suit", "short", "shorts", "tunic", "kimono", "cape", "robe", "gown",
  "walker", "trousers",
];

/**
 * Final post-processing guard: when a pool-picked first name was supplied,
 * make sure NO other first-name token survives anywhere in the AI's body
 * copy. Two sweeps run in order, both reusing replaceNameToken so accent /
 * regex-metachar handling stays in one place:
 *
 *   Sweep 1 — for every first-name token that appears in rawNames[], if
 *   it differs from chosenFirstName, replace it across hero / closing /
 *   bullets. Catches the case where the AI emitted 3 alternative names
 *   and wrote the body using one of the alternatives (not names[0]).
 *
 *   Sweep 2 — pattern-anchored: capture "the {CapitalizedName} {garment}"
 *   and "Reach for (the )?{CapitalizedName}". Any captured name that is
 *   not chosenFirstName gets swept. Catches the 2026-05-11 Nomalanga case
 *   where the AI complied for names[] yet leaked an anchor-pool name
 *   ("Élise") into the body — that name doesn't appear in rawNames[] so
 *   Sweep 1 can't see it.
 *
 * The return type's `swept` is for logging — see callers.
 */
export function enforceChosenFirstName(input: {
  rawNames: string[];
  heroDescription: string;
  closingLine: string;
  bullets?: string[];
  chosenFirstName: string;
}): {
  rawNames: string[];
  heroDescription: string;
  closingLine: string;
  bullets: string[];
  swept: { fromAlternatives: string[]; fromPattern: string[] };
} {
  const { chosenFirstName } = input;
  const originalRawNames = input.rawNames;
  const rawNames = forceFirstName(originalRawNames, chosenFirstName);

  let heroDescription = input.heroDescription;
  let closingLine = input.closingLine;
  let bullets = (input.bullets ?? []).slice();

  const fromAlternatives: string[] = [];
  const fromPattern: string[] = [];

  // Apply a single replacement across all body fields. Returns true when
  // something actually changed — that's how we know whether to log the
  // name in the swept-audit array.
  const sweepInBody = (name: string): boolean => {
    if (!name || name === chosenFirstName) return false;
    let touched = false;
    const heroNext = replaceNameToken(heroDescription, name, chosenFirstName);
    if (heroNext !== heroDescription) {
      heroDescription = heroNext;
      touched = true;
    }
    const closingNext = replaceNameToken(closingLine, name, chosenFirstName);
    if (closingNext !== closingLine) {
      closingLine = closingNext;
      touched = true;
    }
    bullets = bullets.map((b) => {
      const next = replaceNameToken(b, name, chosenFirstName);
      if (next !== b) touched = true;
      return next;
    });
    return touched;
  };

  // Sweep 1: every first-name token from the original rawNames[].
  const seenAlt = new Set<string>();
  for (const entry of originalRawNames) {
    const token = extractFirstNameToken(entry);
    if (!token || token === chosenFirstName) continue;
    if (seenAlt.has(token)) continue;
    seenAlt.add(token);
    if (sweepInBody(token)) fromAlternatives.push(token);
  }

  // Sweep 2: pattern-anchored capture against the AI's "the {Name}
  // {garment}" / "Reach for (the )?{Name}" phrasing. Run AFTER sweep 1
  // — anything left here is by definition not in rawNames[].
  const garmentAlt = ENFORCE_GARMENT_NOUNS.join("|");
  const articleRe = new RegExp(
    `\\b[Tt]he\\s+([A-ZÀ-Ÿ][a-zà-ÿ]+)\\s+(?:${garmentAlt})\\b`,
    "g",
  );
  const reachRe = /\bReach for (?:the )?([A-ZÀ-Ÿ][a-zà-ÿ]+)\b/g;

  const collect = (text: string, out: Set<string>) => {
    for (const re of [articleRe, reachRe]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (m[1] && m[1] !== chosenFirstName) out.add(m[1]);
      }
    }
  };

  const patternCandidates = new Set<string>();
  collect(heroDescription, patternCandidates);
  collect(closingLine, patternCandidates);
  for (const b of bullets) collect(b, patternCandidates);

  for (const name of patternCandidates) {
    if (sweepInBody(name)) fromPattern.push(name);
  }

  return {
    rawNames,
    heroDescription,
    closingLine,
    bullets,
    swept: { fromAlternatives, fromPattern },
  };
}

export async function enhanceProduct(
  apiKey: string,
  opts: {
    title: string;
    description: string;
    language?: string;
    gender?: "women" | "men" | "unisex";
    usedNames?: string[];
    /** See enhanceAndTranslate.chosenFirstName — same semantics. */
    chosenFirstName?: string;
  }
): Promise<{
  names: Array<{ name: string; available: boolean }>;
  heroDescription: string;
  bulletHeader: string;
  bullets: string[];
  closingLine: string;
}> {
  const client = getClient(apiKey);
  const lang = opts.language || "English";

  // Stable system prompt: depends only on (language, gender). Within a batch
  // these are constant, so products 2..N can hit the prompt cache seeded by
  // product 1. Anything that varies per call (forbidden names, product data)
  // MUST live in the user message, otherwise the cache key changes every
  // request and caching never engages.
  const systemPrompt = `You are a creative product copywriter for a modern, elegant fashion brand. Write in ${lang}.

Your task: Given a product title and description, create compelling enhanced copy.

IMPORTANT — Naming rules:
- This is a ${opts.gender === "men" ? "MEN'S" : opts.gender === "women" ? "WOMEN'S" : "UNISEX"} product collection. ALL first names MUST be ${opts.gender === "men" ? "MASCULINE (e.g. Hugo, Lucas, Théo, Marco, Raphaël, Matteo, Santiago)" : opts.gender === "women" ? "FEMININE (e.g. Margot, Chloé, Léa, Camille, Sofia, Valentina)" : "UNISEX (e.g. Alex, Sam, Jordan, Quinn)"}. Do NOT use ${opts.gender === "men" ? "feminine" : opts.gender === "women" ? "masculine" : "gendered"} names.
- Each product in a collection MUST have a unique first name. Never repeat a first name.
- A list of FORBIDDEN NAMES may be supplied in the user message — every name you return MUST differ from that list. This is a hard constraint.
- The first entry in "names" should always be the best/preferred option.

Return ONLY valid JSON in this exact format:
{
  "names": ["Name | Descriptors in ${lang}", "Name | Alt Descriptors", "Name | Alt Descriptors"],
  "heroDescription": "A compelling 1-2 sentence description",
  "bulletHeader": "Why You'll Love It",
  "bullets": ["Feature 1: Benefit 1", "Feature 2: Benefit 2", "Feature 3: Benefit 3", "Feature 4: Benefit 4", "Feature 5: Benefit 5"],
  "closingLine": "A closing sentence mentioning the product"
}

Name format: [First Name] | [Key Descriptors + Garment Type]
Bullets format: [Feature]: [Benefit]
All text must be in ${lang}.
IMPORTANT: Product names will appear inside a gendered navigation menu (under "Women" or "Men"). Do NOT include gender words like "Women's"/"Men's"/"para Hombre"/"para Mujer"/"Donna"/"Uomo"/"Damen"/"Herren"/"Femme"/"Homme" in the name — gender is already clear from context. Keep names SHORT (max 6 words after the |).
IMPORTANT: NEVER reference the source/original brand name, store name, or any trademarked names (e.g. "Bloom™", "Amsterdam", etc.) in the output. The generated first name IS the brand — use it in the description and closing line instead. For example, if the name is "Théo | Gorra Denim", refer to it as "the Théo cap" not "the Bloom™ cap".`;

  // Forbidden names + chosenFirstName vary per call → user message,
  // not system. chosenFirstName supersedes the forbidden-list /
  // gender-anchor rules in the system prompt when present.
  const chosenNameBlock = opts.chosenFirstName
    ? `USE THIS EXACT FIRST NAME: "${opts.chosenFirstName}"\nThis instruction supersedes the gender-anchor and forbidden-names rules in the system prompt. Every entry in the "names" array MUST start with "${opts.chosenFirstName} | " and only differ in the descriptors after the pipe. Do NOT pick a different name.\n\n`
    : "";
  const forbiddenBlock =
    opts.chosenFirstName || !opts.usedNames?.length
      ? ""
      : `FORBIDDEN NAMES (already used in this batch — do NOT reuse any): ${opts.usedNames.join(", ")}\n\n`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    system: [
      {
        type: "text",
        text: systemPrompt,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: `${chosenNameBlock}${forbiddenBlock}Product title: ${opts.title}\nDescription: ${opts.description || "No description available"}`,
      },
    ],
  });

  // Track usage
  try {
    const usage = response.usage as {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    const inputTokens = usage?.input_tokens || 0;
    const outputTokens = usage?.output_tokens || 0;
    const cacheWrite = usage?.cache_creation_input_tokens || 0;
    const cacheRead = usage?.cache_read_input_tokens || 0;
    // Server-side visibility: confirm caching is engaging. Cache reads
    // should be near the full system-prompt size from the 2nd call in a
    // batch onward. If cacheRead stays 0, the prompt is below the model's
    // minimum cacheable prefix (~1024 tok for Sonnet) and the whole
    // prompt needs to grow (e.g. add few-shot examples) to benefit.
    if (cacheWrite || cacheRead) {
      console.log(
        `[enhance] cache_write=${cacheWrite} cache_read=${cacheRead} in=${inputTokens} out=${outputTokens}`
      );
    }
    await trackUsage({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: inputTokens + cacheWrite + cacheRead,
      outputTokens,
      cost: estimateAnthropicCost(inputTokens, outputTokens, "claude-sonnet-4-6"),
      purpose: "product-enhancement",
    });
  } catch {}

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Failed to parse AI response");

  const parsed = JSON.parse(jsonMatch[0]);

  const usedSet = new Set(
    (opts.usedNames || []).map((n) => n.toLowerCase())
  );
  let rawNames: string[] = Array.isArray(parsed.names) ? parsed.names : [];
  let heroDescription: string = parsed.heroDescription || "";
  let closingLine: string = parsed.closingLine || "";
  let bullets: string[] = Array.isArray(parsed.bullets) ? parsed.bullets : [];

  // Same chosenFirstName enforcement as enhanceAndTranslate — see
  // enforceChosenFirstName for the two-sweep guard.
  if (opts.chosenFirstName) {
    const enforced = enforceChosenFirstName({
      rawNames,
      heroDescription,
      closingLine,
      bullets,
      chosenFirstName: opts.chosenFirstName,
    });
    rawNames = enforced.rawNames;
    heroDescription = enforced.heroDescription;
    closingLine = enforced.closingLine;
    bullets = enforced.bullets;
    if (enforced.swept.fromAlternatives.length || enforced.swept.fromPattern.length) {
      console.log(
        `[enhance] override-applied: pool="${opts.chosenFirstName}" ` +
          `alt=[${enforced.swept.fromAlternatives.join(",")}] ` +
          `pattern=[${enforced.swept.fromPattern.join(",")}]`,
      );
    }
  }

  const names = rawNames.map((name: string) => {
    const firstName = name.split("|")[0].trim();
    const isUsed = usedSet.has(firstName.toLowerCase());
    return { name, available: !isUsed };
  });

  return {
    names,
    heroDescription,
    bulletHeader: parsed.bulletHeader || "Why You'll Love It",
    bullets,
    closingLine,
  };
}

export async function translateVariants(
  apiKey: string,
  opts: {
    optionNames?: string[];
    variants: Array<{
      option1?: string | null;
      option2?: string | null;
      option3?: string | null;
    }>;
    targetLanguage: string;
  }
): Promise<{
  options: Array<{
    originalName: string;
    translatedName: string;
    values: Record<string, string>;
  }>;
}> {
  const client = getClient(apiKey);

  // Extract unique option names and values
  const optionMap: Record<string, Set<string>> = {};
  for (const v of opts.variants) {
    if (v.option1) {
      if (!optionMap["option1"]) optionMap["option1"] = new Set();
      optionMap["option1"].add(v.option1);
    }
    if (v.option2) {
      if (!optionMap["option2"]) optionMap["option2"] = new Set();
      optionMap["option2"].add(v.option2);
    }
    if (v.option3) {
      if (!optionMap["option3"]) optionMap["option3"] = new Set();
      optionMap["option3"].add(v.option3);
    }
  }

  const optionNameMap: Record<string, string> = {};
  if (opts.optionNames) {
    opts.optionNames.forEach((name, i) => { optionNameMap[`option${i + 1}`] = name; });
  }

  const optionsToTranslate = Object.entries(optionMap).map(
    ([key, values]) => ({
      key,
      name: optionNameMap[key] || key,
      values: Array.from(values),
    })
  );

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: `Translate these product variant option names and values to ${opts.targetLanguage}. Return ONLY valid JSON.

Options: ${JSON.stringify(optionsToTranslate)}

Format:
{ "options": [{ "originalName": "option1", "translatedName": "Color", "values": { "original_value": "translated_value" } }] }

Rules:
- "translatedName" must be the proper translated name for the option (e.g. "Kleur" → "Color", "Maat" → "Talla", "Size" → "Talla", "Couleur" → "Color")
- Do NOT literally translate "option1"/"option2" — use the "name" field to determine the real option name`,
      },
    ],
  });

  // Track usage
  try {
    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;
    await trackUsage({
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      inputTokens,
      outputTokens,
      cost: estimateAnthropicCost(inputTokens, outputTokens, "claude-haiku-4-5-20251001"),
      purpose: "variant-translation",
    });
  } catch {}

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Failed to parse translation response");

  return JSON.parse(jsonMatch[0]);
}

export interface CollectionNameGenOpts {
  productTitles: string[];
  productDescriptions?: string[];
  productTypes?: string[];
  sourceCollectionUrl?: string;
  language?: string;
  existingNames?: string[];
}

/**
 * Build the Haiku prompt that generates collection-name candidates.
 *
 * Extracted as a pure helper so the language-enforcement logic is unit-
 * testable without a live LLM call.
 *
 * The output-language directive is emitted for EVERY target language,
 * including English. This is the fix for the 2026-06-18 "Leichte Midi &
 * Maxi Kleider" incident: the source slug + product titles fed in here are
 * still in the source language (e.g. German) at plan time, so without an
 * explicit "write in English, translate foreign terms" instruction the
 * model mirrored the German source for English/USD stores. The generated
 * name is written to Shopify verbatim, so it has to be in the store's
 * language at this step — nothing downstream translates it.
 */
export function buildCollectionNameGenPrompt(opts: CollectionNameGenOpts): string {
  const productsContext = opts.productTitles
    .map((title, i) => {
      const parts = [title];
      if (opts.productTypes?.[i]) parts.push(`(type: ${opts.productTypes[i]})`);
      if (opts.productDescriptions?.[i]) {
        const desc = opts.productDescriptions[i];
        parts.push(`— ${desc.length > 150 ? desc.slice(0, 150) + "..." : desc}`);
      }
      return `- ${parts.join(" ")}`;
    })
    .join("\n");

  const sourceSlug = opts.sourceCollectionUrl
    ? opts.sourceCollectionUrl.match(/\/collections\/([^/?#]+)/)?.[1]?.replace(/-/g, " ") || ""
    : "";

  const language = opts.language || "English";
  const languageDirective =
    language === "English"
      ? ` ALL names MUST be written in English. The source collection name and product titles below may be in another language — TRANSLATE any non-English terms into natural English (e.g. German "Leichte Midi & Maxi Kleider" → "Midi & Maxi Dresses"). Never echo or transliterate the foreign-language words.`
      : ` ALL names MUST be written in ${language}. Do NOT use English words or loanwords — use native ${language} vocabulary only. For example in Spanish: "Sudaderas" not "Hoodies", "Camisetas" not "Tops".`;

  return `Suggest 3 collection names (1-4 words each) for a fashion e-commerce collection.${languageDirective}
${sourceSlug ? `\nSource collection was called: "${sourceSlug}"` : ""}

Products:
${productsContext}

${opts.existingNames?.length ? `Avoid these existing names: ${opts.existingNames.join(", ")}` : ""}

The names should be descriptive and navigational — like what a shopper would look for in a menu. Describe the product category, not the brand. Do NOT include the word "Collection"/"Collezione"/"Kollektion" etc. Do NOT use vague/creative names like "Effortless Elegance".
IMPORTANT: The collection will appear inside a gendered navigation menu (e.g. under "Women" or "Men"). Do NOT include gender words like "Women's"/"Men's"/"para Hombre"/"para Mujer"/"Donna"/"Uomo"/"Damen"/"Herren" — gender is already clear from the parent menu.

Return ONLY valid JSON: { "suggestions": ["Name 1", "Name 2", "Name 3"] }`;
}

export async function suggestCollectionName(
  apiKey: string,
  opts: CollectionNameGenOpts
): Promise<{ suggestions: string[] }> {
  const client = getClient(apiKey);

  // Step 1: Generate 3 candidates
  const genResponse = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 256,
    temperature: 0.9,
    messages: [
      {
        role: "user",
        content: buildCollectionNameGenPrompt(opts),
      },
    ],
  });

  // Track usage for generation call
  try {
    const inputTokens = genResponse.usage?.input_tokens || 0;
    const outputTokens = genResponse.usage?.output_tokens || 0;
    await trackUsage({
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      inputTokens,
      outputTokens,
      cost: estimateAnthropicCost(inputTokens, outputTokens, "claude-haiku-4-5-20251001"),
      purpose: "collection-name-generate",
    });
  } catch {}

  const genText =
    genResponse.content[0].type === "text" ? genResponse.content[0].text : "";
  const genMatch = genText.match(/\{[\s\S]*\}/);
  if (!genMatch) throw new Error("Failed to parse suggestion response");

  const candidates: string[] = JSON.parse(genMatch[0]).suggestions;
  if (!candidates || candidates.length === 0) {
    throw new Error("No suggestions generated");
  }
  if (candidates.length === 1) {
    return { suggestions: candidates };
  }

  // Step 2: Pick the best one for navigation
  const pickResponse = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 128,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: `You are choosing a collection name for a fashion store's navigation bar. A customer browsed this collection, left, and now wants to find it again by scanning the nav menu.

Which of these names would they most instantly recognize and click?

${candidates.map((c, i) => `${i + 1}. ${c}`).join("\n")}

Pick the one that is most specific, descriptive, and immediately tells the customer what products are inside.

Return ONLY valid JSON: { "suggestions": ["The Winner"] }`,
      },
    ],
  });

  // Track usage for pick call
  try {
    const pickInputTokens = pickResponse.usage?.input_tokens || 0;
    const pickOutputTokens = pickResponse.usage?.output_tokens || 0;
    await trackUsage({
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      inputTokens: pickInputTokens,
      outputTokens: pickOutputTokens,
      cost: estimateAnthropicCost(pickInputTokens, pickOutputTokens, "claude-haiku-4-5-20251001"),
      purpose: "collection-name-pick",
    });
  } catch {}

  const pickText =
    pickResponse.content[0].type === "text" ? pickResponse.content[0].text : "";
  const pickMatch = pickText.match(/\{[\s\S]*\}/);
  if (!pickMatch) {
    return { suggestions: [candidates[0]] };
  }

  const picked: string[] = JSON.parse(pickMatch[0]).suggestions;
  return { suggestions: [picked?.[0] || candidates[0]] };
}
