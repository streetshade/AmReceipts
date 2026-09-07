import { z } from "zod";
import { prisma } from "@/lib/db";
import { handler, json, error, requireUserId } from "@/lib/api";
import { siteLabel } from "@/lib/geo";
import { appTimeZone, dayRange } from "@/lib/timeRange";

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

// Three ways in. The classic screen names a session. The field screen either
// taps `Log here` on a job the phone matched from its location, or - when it
// could not work out where it is - starts a visit with no job on it and sorts
// that out later, because the receipt is the thing that gets thrown away.
const CreateBody = z.union([
  z.object({ name: z.string().min(1).max(120) }),
  z.object({ jobId: z.string().min(1).max(60) }),
  z.object({ unassigned: z.literal(true) }),
]);

/**
 * Today's visit for this job, if there is one.
 *
 * Arriving on a site twice in a morning is one visit, not two. Without this,
 * `Log here` on the way in and again after lunch splits the day's receipts
 * across two visits a supervisor then approves separately.
 *
 * Only DRAFT visits are resumed: adding a receipt to something already sent for
 * approval changes a total someone is in the middle of signing off.
 *
 * Best-effort, not atomic: two taps landing in the same instant can still make
 * two visits. That is visible on Home and mergeable by hand, where the
 * alternative - a lock or a serialisable retry on every capture - costs more
 * than the fault does.
 */
async function todaysDraftForJob(userId: string, jobId: string) {
  const today = dayRange(new Date(), appTimeZone());
  return prisma.expenseSession.findFirst({
    where: { userId, jobId, approvalStatus: "draft", createdAt: { gte: today.start, lt: today.end } },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Today's draft visit that has no job AND no travel or meeting reason on it.
 *
 * Both halves of that matter. Matching on a null `jobId` alone would also pick
 * up a visit deliberately marked as travel or as a meeting - the assign route
 * leaves `jobId` null and sets `reasonType` - and a visit whose job row was
 * later deleted, which keeps `reasonType: "job"` while the relation nulls
 * itself. Dropping a job receipt into either is putting it somewhere its owner
 * has already said it does not belong.
 */
async function todaysUnassignedDraft(userId: string) {
  const today = dayRange(new Date(), appTimeZone());
  return prisma.expenseSession.findFirst({
    where: {
      userId,
      jobId: null,
      reasonType: null,
      approvalStatus: "draft",
      createdAt: { gte: today.start, lt: today.end },
    },
    orderBy: { createdAt: "desc" },
  });
}

export const POST = handler(async (req: Request) => {
  const userId = requireUserId();
  const parsed = CreateBody.safeParse(await req.json());
  if (!parsed.success) return error("A session name or job is required", 422);

  if ("jobId" in parsed.data) {
    // Scoped to the caller: a job id from another account must not be linkable.
    const job = await prisma.job.findFirst({ where: { id: parsed.data.jobId, userId } });
    if (!job) return error("Job not found", 404);

    const existing = await todaysDraftForJob(userId, job.id);
    if (existing) return json({ id: existing.id, resumed: true });

    const session = await prisma.expenseSession.create({
      data: {
        userId,
        name: siteLabel(job),
        jobId: job.id,
        reasonType: "job",
        status: "assigned",
      },
    });
    return json({ id: session.id, resumed: false }, 201);
  }

  if ("unassigned" in parsed.data) {
    // Resumed the same way a job visit is, so a technician the app could not
    // locate does not collect a fresh visit every time they walk back to Home.
    // It carries no job and no reason, so resuming it cannot book anything to
    // a job - or a trip - that someone has already decided on.
    const existing = await todaysUnassignedDraft(userId);
    if (existing) return json({ id: existing.id, resumed: true });

    const session = await prisma.expenseSession.create({
      data: {
        userId,
        // Dated rather than named after a job, because it has none yet.
        name: `Visit — ${new Intl.DateTimeFormat("en-GB", {
          timeZone: appTimeZone(),
          weekday: "long",
          day: "numeric",
          month: "short",
        }).format(new Date())}`,
      },
    });
    return json({ id: session.id, resumed: false }, 201);
  }

  const session = await prisma.expenseSession.create({
    data: { userId, name: parsed.data.name },
  });
  return json({ id: session.id, resumed: false }, 201);
});
