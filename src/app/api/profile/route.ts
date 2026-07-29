import { z } from "zod";
import { prisma } from "@/lib/db";
import { handler, json, error, requireUser } from "@/lib/api";

// Self-service account record. A user may edit their own name/company/title,
// but NOT their role or group (those are admin-controlled).
const Body = z.object({
  name: z.string().min(1).max(120).optional(),
  company: z.string().max(160).nullable().optional(),
  title: z.string().max(160).nullable().optional(),
});

export const PATCH = handler(async (req: Request) => {
  const user = await requireUser();
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return error("Invalid input", 422);
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: parsed.data,
    select: { id: true, name: true, company: true, title: true },
  });
  return json({ user: updated });
});
