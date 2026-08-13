/**
 * Gemini via Vertex AI — a Google Cloud product, distinct from the plain
 * Gemini Developer API key used elsewhere in this codebase (GEMINI_API_KEY).
 * Routes through a GCP project + service account instead, via
 * GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_LOCATION / GOOGLE_VERTEX_CREDENTIALS_JSON.
 *
 * Sibling to callHaikuText in anthropic-client.ts: same one-shot text-completion
 * shape, best-effort usage tracking that never throws on a tracking failure.
 */

import { GoogleGenAI } from "@google/genai";
import { trackUsage } from "@/lib/usage-tracker";

export const GEMINI_VERTEX_MODEL = "gemini-2.5-flash";

let cachedClient: GoogleGenAI | null = null;

function getVertexClient(): GoogleGenAI {
  if (cachedClient) return cachedClient;

  const project = process.env.GOOGLE_CLOUD_PROJECT;
  const location = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
  const credsJson = process.env.GOOGLE_VERTEX_CREDENTIALS_JSON;
  if (!project || !credsJson) {
    throw new Error(
      "Vertex AI not configured: GOOGLE_CLOUD_PROJECT / GOOGLE_VERTEX_CREDENTIALS_JSON missing"
    );
  }

  cachedClient = new GoogleGenAI({
    vertexai: true,
    project,
    location,
    googleAuthOptions: { credentials: JSON.parse(credsJson) },
  });
  return cachedClient;
}

export interface CallGeminiVertexTextOpts {
  system: string;
  user: string;
  /** Telemetry tag persisted to ApiUsage.purpose. */
  purpose: string;
}

export interface GeminiVertexTextResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * One-shot Gemini text completion via Vertex AI. Throws if Vertex env vars
 * are missing, the call errors, or the response has no text.
 *
 * Best-effort usage tracking — a tracking failure never propagates. Cost is
 * left at 0 (Flash-tier calls at this volume are negligible); add real
 * per-token pricing here if volume ever justifies it.
 */
export async function callGeminiVertexText(
  opts: CallGeminiVertexTextOpts
): Promise<GeminiVertexTextResult> {
  const ai = getVertexClient();

  const response = await ai.models.generateContent({
    model: GEMINI_VERTEX_MODEL,
    contents: opts.user,
    config: { systemInstruction: opts.system },
  });

  const text = response.text;
  if (!text) throw new Error("Gemini Vertex response had no text content");

  const usage = response.usageMetadata;
  const inputTokens = usage?.promptTokenCount ?? 0;
  const outputTokens = usage?.candidatesTokenCount ?? 0;

  try {
    await trackUsage({
      provider: "gemini",
      model: GEMINI_VERTEX_MODEL,
      inputTokens,
      outputTokens,
      cost: 0,
      purpose: opts.purpose,
    });
  } catch {
    // best-effort — never let tracking failure break the caller
  }

  return { text, inputTokens, outputTokens };
}
