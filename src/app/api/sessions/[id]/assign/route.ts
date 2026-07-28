import { z } from "zod";
import { prisma } from "@/lib/db";
import { handler, json, error, requireUserId } from "@/lib/api";

type Params = { params: { id: string } };

// Assign a session either to a job number, or to a travel/meeting reason.
const Body = z
  .object({
    jobNumber: z.string().min(1).max(60).optional(),
    jobName: z.string().max(160).optional(),
    reasonType: z.enum(["travel", "meeting"]).optional(),
    reasonNote: z.string().max(500).optional(),
  })
  .refine((b) => b.jobNumber || b.reasonType, {
    message: "Provide either a job number or a travel/meeting reason",
  });

export const POST = handler(async (req: Request, { params }: Params) => {
  const userId = requireUserId();
  const owned = await prisma.expenseSession.findFirst({ where: { id: params.id, userId } });
  if (!owned) return error("Session not found", 404);

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return error(parsed.error.issues[0]?.message ?? "Invalid input", 422);
  const { jobNumber, jobName, reasonType, reasonNote } = parsed.data;

  if (jobNumber) {
    // Upsert the job into the user's account, then link.
    const job = await prisma.job.upsert({
      where: { userId_number: { userId, number: jobNumber } },
      update: jobName ? { name: jobName } : {},
      create: { userId, number: jobNumber, name: jobName ?? null },
    });
    const session = await prisma.expenseSession.update({
      where: { id: params.id },
      data: { jobId: job.id, reasonType: "job", reasonNote: jobName ?? null, status: "assigned" },
    });
    return json({ id: session.id, status: session.status });
  }

  const session = await prisma.expenseSession.update({
    where: { id: params.id },
    data: { jobId: null, reasonType, reasonNote: reasonNote ?? null, status: "assigned" },
  });
  return json({ id: session.id, status: session.status });
});
