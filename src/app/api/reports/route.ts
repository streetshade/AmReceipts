import { handler, json, requireUserId } from "@/lib/api";
import { buildReport } from "@/lib/reports";

export const dynamic = "force-dynamic";

export const GET = handler(async () => {
  const userId = requireUserId();
  return json(await buildReport(userId));
});
