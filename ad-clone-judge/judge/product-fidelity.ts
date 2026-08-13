/**
 * Product-fidelity vision compare — the second QC axis of the still loop.
 *
 * The composition compare (`compareShot`, mode "still") measures divergence
 * from the REFERENCE frame; a wholesale copy of that frame — competitor's
 * product included — is its best possible score. This check verifies the
 * swapped-IN content instead: is the product visible in our rendered still
 * OUR product from the catalog photos? (General law: every swap needs a
 * verifier for the swapped-in content, not just the preserved context. Run
 * cmruxrpx shipped a "match, severity 0" still of the competitor's shoe.)
 *
 * Standalone by design so the UGC lanes can port it later. One sonnet
 * vision call: catalog images first, then the still, then the question.
 * Throws on any parse/shape failure — the caller's existing pending-attempt
 * checkpoint path handles it (still-loop.ts Finding 12 discipline).
 */

import { z } from "zod";
import { createAnthropic } from "@/lib/anthropic-factory";
import { resolveKey } from "@/lib/api-keys-store";
import { trackAnthropicUsage, type AnthropicUsageLike } from "@/lib/usage-tracker";
import { estimateAnthropicCost } from "@/lib/anthropic-pricing";
import { SONNET_MODEL } from "@/lib/anthropic-client";
import { getObjectBuffer } from "@/lib/storage/r2";
import { IMAGE_BUCKET } from "@/lib/storage/save-image";
import { resizeVisionImage } from "@/lib/creative-scorer/media";
import { extractJsonObject, repairUnescapedInnerQuotes } from "../strategize/validate";

const PURPOSE = "ad-clone-product-fidelity";

export const PRODUCT_FIDELITY_VERDICTS = ["ours", "wrong-product", "no-product"] as const;
export type ProductFidelityVerdict = (typeof PRODUCT_FIDELITY_VERDICTS)[number];

/** Catalog images sent per compare — enough to establish identity without
 *  blowing the per-request image budget. */
export const MAX_PRODUCT_FIDELITY_CATALOG_IMAGES = 3;

export interface ProductFidelityResult {
  verdict: ProductFidelityVerdict;
  /** 0 faithful | 1 minor drift | 3 wrong/no product. */
  severity: number;
  /** Imperative correction for the next still attempt; "" when severity 0. */
  fix: string;
  prompt: string;
  response: string;
  costUsd: number;
}

/** Minimal Anthropic-shaped response — covers both the lane client and test fakes. */
interface FidelityMessageResponse {
  content: Array<{ type: string; text?: string }>;
  usage?: unknown;
}

export interface ProductFidelityDeps {
  client?: {
    messages: {
      create(req: unknown, opts?: unknown): Promise<FidelityMessageResponse>;
    };
  };
  resolveApiKey?: (keyName: string) => Promise<string | null | undefined>;
  track?: typeof trackAnthropicUsage;
  getObject?: typeof getObjectBuffer;
  resize?: typeof resizeVisionImage;
  /** External catalog image fetcher — injectable so tests never hit the network. */
  fetchImage?: (url: string) => Promise<Buffer>;
}

const ResponseSchema = z.object({
  verdict: z.enum(PRODUCT_FIDELITY_VERDICTS),
  severity: z.number().int().min(0).max(3),
  fix: z.string(),
});

// fix-ad-clone-collage-erro: same repair as judge/compare.ts's
// parseComparisonJson — `fix` is free text and can quote the reference's
// on-screen wording, which the model sometimes wraps in plain double-quotes
// and breaks the JSON string. See repairUnescapedInnerQuotes's doc comment.
const PRODUCT_FIDELITY_STRING_KEYS = ["verdict", "fix"];
const UNESCAPED_QUOTE_ERROR = /Expected ',' or '}' after property value in JSON/;

function parseProductFidelityResponse(responseText: string): z.infer<typeof ResponseSchema> {
  const jsonText = extractJsonObject(responseText);
  try {
    return ResponseSchema.parse(JSON.parse(jsonText));
  } catch (err) {
    const isJsonSyntaxError = err instanceof SyntaxError && UNESCAPED_QUOTE_ERROR.test(err.message);
    if (!isJsonSyntaxError) throw err;
    const repaired = repairUnescapedInnerQuotes(jsonText, PRODUCT_FIDELITY_STRING_KEYS);
    if (repaired === jsonText) throw err;
    return ResponseSchema.parse(JSON.parse(repaired));
  }
}

async function defaultFetchImage(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`compareProductFidelity: failed to fetch catalog image ${url}: HTTP ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

function presentationPhrase(presentation: "worn" | "held" | "displayed"): string {
  switch (presentation) {
    case "worn":
      return "worn by the model";
    case "held":
      return "held/handled by the model";
    case "displayed":
      return "displayed in the scene";
  }
}

function buildPrompt(title: string, catalogCount: number, presentation: "worn" | "held" | "displayed"): string {
  const visiblePhrase = presentation === "worn" ? "worn" : presentation === "held" ? "held" : "displayed";
  return `The first ${catalogCount} image${catalogCount === 1 ? "" : "s"} are OUR catalog photos of the product "${title}". The LAST image is a generated ad still in which that product must appear ${presentationPhrase(presentation)}.

Judge ONE question: is the product visible in the LAST image OUR product from the catalog photos?
- "ours": same product - shape, colour, materials and distinctive details match the catalog (allow lighting/angle differences).
- "wrong-product": a DIFFERENT product appears where ours should be.
- "no-product": no product is visibly ${visiblePhrase} at all.

Catalog photos are STYLED: they may also show bags, jewellery, eyewear, footwear, other garments, and a set/background that are NOT the product being judged. Ignore all of it - judge the product itself and nothing else, and never call it "wrong-product" because the styling or setting differs.

severity: 0 for "ours" with a faithful match, 1 for "ours" with minor drift (slightly off colour/detail), 3 for "wrong-product" or "no-product".
fix: for any non-zero severity, ONE imperative sentence telling an image model what to change, describing OUR product from the catalog images. Describe ONLY the product itself - never the styling props (bags, jewellery, eyewear, footwear, other garments) or the setting visible in the catalog photos, because the renderer will reproduce whatever this sentence mentions. Empty string when severity is 0.

Return ONLY this JSON object, no prose, no markdown fences:
{"verdict": "ours" | "wrong-product" | "no-product", "severity": <0|1|3>, "fix": "<sentence or empty>"}`;
}

export async function compareProductFidelity(
  input: {
    stillR2Key: string;
    productTitle: string;
    productImageUrls: string[];
    presentation: "worn" | "held" | "displayed";
  },
  deps: ProductFidelityDeps = {},
): Promise<ProductFidelityResult> {
  const getObject = deps.getObject ?? getObjectBuffer;
  const resize = deps.resize ?? resizeVisionImage;
  const fetchImage = deps.fetchImage ?? defaultFetchImage;
  const track = deps.track ?? trackAnthropicUsage;

  if (input.productImageUrls.length === 0) {
    throw new Error("compareProductFidelity: productImageUrls must not be empty");
  }
  const catalogUrls = input.productImageUrls.slice(0, MAX_PRODUCT_FIDELITY_CATALOG_IMAGES);

  // --- Load + resize every image (catalog first, still last) --------------
  type ImageBlock = { type: "image"; source: { type: "base64"; media_type: string; data: string } };
  const imageBlocks: ImageBlock[] = [];
  for (const url of catalogUrls) {
    const buf = await fetchImage(url);
    const resized = await resize({ base64: buf.toString("base64"), contentType: "image/jpeg" });
    imageBlocks.push({ type: "image", source: { type: "base64", media_type: resized.contentType, data: resized.base64 } });
  }
  const stillObj = await getObject({ bucket: IMAGE_BUCKET, key: input.stillR2Key });
  const stillResized = await resize({ base64: stillObj.buffer.toString("base64"), contentType: "image/jpeg" });
  imageBlocks.push({
    type: "image",
    source: { type: "base64", media_type: stillResized.contentType, data: stillResized.base64 },
  });

  // --- Client (ADS-first lane) --------------------------------------------
  let client = deps.client;
  if (!client) {
    const resolve = deps.resolveApiKey ?? resolveKey;
    let apiKey = await resolve("ANTHROPIC_API_KEY_ADS");
    if (!apiKey) {
      console.warn("[ad-clone-product-fidelity] ANTHROPIC_API_KEY_ADS not available; falling back to ANTHROPIC_API_KEY");
      apiKey = await resolve("ANTHROPIC_API_KEY");
    }
    if (!apiKey) throw new Error("no Anthropic API key available for ad-clone product-fidelity");
    client = createAnthropic({ apiKey, purpose: PURPOSE, ads: true });
  }

  const promptText = buildPrompt(input.productTitle, catalogUrls.length, input.presentation);

  const res = await client.messages.create(
    {
      model: SONNET_MODEL,
      max_tokens: 400,
      temperature: 0,
      messages: [{ role: "user", content: [...imageBlocks, { type: "text", text: promptText }] }],
    },
    { timeout: 120_000 },
  );

  // Cost tracking FIRST (before any parse can throw); never fails the call.
  let costUsd = 0;
  try {
    const usage = res.usage as AnthropicUsageLike | null | undefined;
    costUsd = estimateAnthropicCost(usage?.input_tokens ?? 0, usage?.output_tokens ?? 0, SONNET_MODEL);
    await track({ usage, model: SONNET_MODEL, purpose: PURPOSE });
  } catch {
    /* usage tracking must never fail the call */
  }

  const responseText = res.content.find((b) => b.type === "text")?.text ?? "";
  const validated = parseProductFidelityResponse(responseText);

  return {
    verdict: validated.verdict,
    severity: validated.severity,
    fix: validated.fix,
    prompt: promptText,
    response: responseText,
    costUsd,
  };
}
