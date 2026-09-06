import { z } from "zod";
import { handler, json, error, requireRole } from "@/lib/api";
import { setUiVersion, getUiVersion } from "@/lib/settings";

export const dynamic = "force-dynamic";

const Body = z.object({ uiVersion: z.enum(["field", "classic"]) });

// Admin: choose which interface the site serves.
export const PATCH = handler(async (req: Request) => {
  await requireRole("admin");
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return error("Invalid interface selection", 422);

  await setUiVersion(parsed.data.uiVersion);
  return json({ uiVersion: await getUiVersion() });
});
