import { z } from "zod";
import { prisma } from "@/lib/db";
import { handler, json, error, requireRole } from "@/lib/api";
import { canOversee } from "@/lib/access";

type Params = { params: { id: string } }; // id = sessionId

const Body = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().max(500).optional(),
});

// An approver (or admin) approves or rejects a submitted session belonging to a
// user they oversee.
export const POST = handler(async (req: Request, { params }: Params) => {
  const actor = await requireRole("approver");
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return error("Invalid input", 422);

  const session = await prisma.expenseSession.findUnique({ where: { id: params.id } });
  if (!session) return error("Session not found", 404);
  if (!(await canOversee(actor, session.userId))) return error("Not authorized for this user", 403);
  if (session.approvalStatus !== "submitted") return error("Session is not awaiting approval", 409);

  const updated = await prisma.expenseSession.update({
    where: { id: session.id },
    data: {
      approvalStatus: parsed.data.decision === "approve" ? "approved" : "rejected",
      approvedAt: new Date(),
      approvedById: actor.id,
      approvalNote: parsed.data.note ?? null,
    },
  });
  return json({ id: updated.id, approvalStatus: updated.approvalStatus });
});
