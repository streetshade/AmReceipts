import { z } from "zod";
import { prisma } from "@/lib/db";
import { handler, json, error, requireUserId } from "@/lib/api";

export const GET = handler(async () => {
  const userId = requireUserId();
  const jobs = await prisma.job.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
  return json({ jobs });
});

const Body = z.object({ number: z.string().min(1).max(60), name: z.string().max(160).optional() });

export const POST = handler(async (req: Request) => {
  const userId = requireUserId();
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return error("A job number is required", 422);
  const job = await prisma.job.upsert({
    where: { userId_number: { userId, number: parsed.data.number } },
    update: parsed.data.name ? { name: parsed.data.name } : {},
    create: { userId, number: parsed.data.number, name: parsed.data.name ?? null },
  });
  return json({ job }, 201);
});
