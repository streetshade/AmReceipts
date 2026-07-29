import { z } from "zod";
import { prisma } from "@/lib/db";
import { handler, json, error, requireUser } from "@/lib/api";
import { availableReasons } from "@/lib/access";

type Params = { params: { id: string } };

// Assign a session to a job number, or a travel/meeting reason, plus an
// optional managed reason from the group's catalog.
const Body = z
  .object({
    jobNumber: z.string().min(1).max(60).optional(),
    jobName: z.string().max(160).optional(),
    reasonType: z.enum(["travel", "meeting"]).optional(),
    reasonNote: z.string().max(500).optional(),
    // Managed reason from the catalog; null clears it.
    reasonId: z.string().nullable().optional(),
  })
  .refine((b) => b.jobNumber || b.reasonType, {
    message: "Provide either a job number or a travel/meeting reason",
  });

export const POST = handler(async (req: Request, { params }: Params) => {
  const user = await requireUser();
  const owned = await prisma.expenseSession.findFirst({ where: { id: params.id, userId: user.id } });
  if (!owned) return error("Session not found", 404);

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return error(parsed.error.issues[0]?.message ?? "Invalid input", 422);
  const { jobNumber, jobName, reasonType, reasonNote, reasonId } = parsed.data;

  // Validate the managed reason is one available to this user.
  if (reasonId) {
    const allowed = await availableReasons({ id: user.id, groupId: user.groupId });
    if (!allowed.some((r) => r.id === reasonId)) return error("That reason is not available to you", 422);
  }
  const reasonIdData = reasonId === undefined ? undefined : reasonId;

  if (jobNumber) {
    const job = await prisma.job.upsert({
      where: { userId_number: { userId: user.id, number: jobNumber } },
      update: jobName ? { name: jobName } : {},
      create: { userId: user.id, number: jobNumber, name: jobName ?? null },
    });
    const session = await prisma.expenseSession.update({
      where: { id: params.id },
      data: { jobId: job.id, reasonType: "job", reasonNote: jobName ?? null, reasonId: reasonIdData, status: "assigned" },
    });
    return json({ id: session.id, status: session.status });
  }

  const session = await prisma.expenseSession.update({
    where: { id: params.id },
    data: { jobId: null, reasonType, reasonNote: reasonNote ?? null, reasonId: reasonIdData, status: "assigned" },
  });
  return json({ id: session.id, status: session.status });
});
