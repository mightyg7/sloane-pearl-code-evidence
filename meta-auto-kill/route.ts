// POST /api/cron/meta-auto-kill — fired every 5 minutes by the
// `cron-ticker-auto-kill` Railway cron service. Runs the auto-kill
// engine against today's tracked campaigns and pauses underperformers.
//
// Auth: Authorization: Bearer $CRON_SECRET (same secret the research
// ticker uses). Unauthenticated requests get 401. Without this guard
// anyone who knows the URL could force real Meta campaign pauses.

import { NextRequest, NextResponse } from "next/server";
import { runAutoKill } from "@/lib/meta-ads/auto-kill";
import { verifyCronAuth } from "@/lib/auth/require-cron";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

function authOk(req: NextRequest): boolean {
  return verifyCronAuth(req);
}

export async function POST(req: NextRequest) {
  if (!authOk(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await runAutoKill();
    return NextResponse.json({ ...result, timestamp: new Date().toISOString() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500 });
  }
}
