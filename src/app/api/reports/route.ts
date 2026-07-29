import { handler, json, requireUser } from "@/lib/api";
import { buildReport } from "@/lib/reports";

export const dynamic = "force-dynamic";

// Self report for the current user.
export const GET = handler(async () => {
  const user = await requireUser();
  return json(await buildReport([user.id]));
});
