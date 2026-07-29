import { z } from "zod";
import { prisma } from "@/lib/db";
import { handler, json, error, requireRole } from "@/lib/api";

type Params = { params: { key: string } };

const Body = z.object({
  enabled: z.boolean().optional(),
  // Free-form config object; stored as a JSON string.
  config: z.record(z.any()).optional(),
});

// Admin: update an integration's enabled state and config. This is a stub —
// config is persisted, but no external calls are made yet.
export const PATCH = handler(async (req: Request, { params }: Params) => {
  await requireRole("admin");
  const integration = await prisma.integration.findUnique({ where: { key: params.key } });
  if (!integration) return error("Integration not found", 404);

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return error("Invalid input", 422);

  const updated = await prisma.integration.update({
    where: { key: params.key },
    data: {
      enabled: parsed.data.enabled,
      config: parsed.data.config ? JSON.stringify(parsed.data.config) : undefined,
    },
  });
  return json({ integration: { ...updated, config: JSON.parse(updated.config) } });
});
