import { z } from "zod";
import { prisma } from "@/lib/db";
import { handler, json, error, requireUserId } from "@/lib/api";

export const GET = handler(async () => {
  const userId = requireUserId();
  const sessions = await prisma.expenseSession.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: {
      job: true,
      receipts: { select: { total: true } },
      _count: { select: { receipts: true, scannedItems: true } },
    },
  });

  const shaped = sessions.map((s) => ({
    id: s.id,
    name: s.name,
    status: s.status,
    reasonType: s.reasonType,
    reasonNote: s.reasonNote,
    job: s.job ? { id: s.job.id, number: s.job.number, name: s.job.name } : null,
    receiptCount: s._count.receipts,
    itemCount: s._count.scannedItems,
    total: s.receipts.reduce((acc, r) => acc + (r.total ?? 0), 0),
    createdAt: s.createdAt,
  }));

  return json({ sessions: shaped });
});

const CreateBody = z.object({ name: z.string().min(1).max(120) });

export const POST = handler(async (req: Request) => {
  const userId = requireUserId();
  const parsed = CreateBody.safeParse(await req.json());
  if (!parsed.success) return error("A session name is required", 422);
  const session = await prisma.expenseSession.create({
    data: { userId, name: parsed.data.name },
  });
  return json({ id: session.id }, 201);
});
