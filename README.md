# Sloane & Pearl — Code Evidence

This repo is **read-only source excerpts**, not a working checkout. It exists
so judges can verify that the specific AI-decision mechanisms cited in
Sloane & Pearl's submission are real code, not narrative claims — nothing
here runs standalone (the source is DB-coupled, env-coupled, and part of a
much larger platform).

For the full submission narrative, financials, and disclosure docs, see the
main submission repo (shared separately). For proof these mechanisms are
*live in production* for Sloane & Pearl specifically — not just present in
the codebase — see that repo's `evidence/agent-logs/` (real, dated exports
from the production database) and the demo video.

## What's here, and what claim each directory backs

- **`meta-auto-kill/`** — pauses a live, spending Meta ad campaign
  automatically when performance thresholds are crossed, with no human
  approval between evaluation and the pause. Runs every 5 minutes via a
  scheduled cron hitting `route.ts`. Backs the "95 auto-killed of 127
  launched campaigns" claim.
- **`angle-loop/`** — a nightly job that reads 30 days of real ad
  performance and has an LLM write a new ad-strategy brief (which creative
  angles to weight up or avoid), consumed directly by live ad-copy
  generation with no human review. `pain-points.ts` shows the consumption
  side.
- **`ad-clone-judge/`** — an AI vision judge that compares a generated video
  frame against the original ad it's cloning, decides pass/fail per shot,
  and autonomously triggers a re-render with AI-written fix instructions —
  bounded, multi-pass, before any human picks the final asset.
- **`airwallex-treasury/`** — forecasts an ad account's burn rate and
  autonomously fires a real bank transfer to top it up when projected
  runway drops below threshold. No human approval per transfer.
- **`supplier-size-chart/`** — opens and pursues a request to a real
  supplier (via Discord) the moment a product's first paid sale happens,
  and uses AI vision to parse the supplier's uploaded photo into a
  structured, translated measurement table.
- **`pricing-auto-apply/`** — recomputes a break-even-optimal retail price
  from live COGS/FX/fee data and rewrites it directly on the live Shopify
  store, including price cuts, with no human review by design.
- **`catalog-copy-gemini/`** — the Gemini/Vertex AI integration
  (`vertex-provider.ts`, new) and its call site (`ai-enhance.ts`), which
  satisfies the hackathon's Gemini + Google Cloud requirement. Scoped to
  Sloane & Pearl only; every other store on the platform is unaffected.

## A note on file scope

Every file here is a real, unmodified excerpt from the platform's actual
source tree (only relative import paths may not resolve, since this repo
doesn't include the rest of the codebase around them). Nothing has been
rewritten, simplified, or illustratively reconstructed for this repo.
