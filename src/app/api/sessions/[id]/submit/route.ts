import { prisma } from "@/lib/db";
import { handler, json, error, requireUserId } from "@/lib/api";

type Params = { params: { id: string } };

// A basic user submits their session for approval. Allowed from draft or
// rejected (resubmit after fixes).
export const POST = handler(async (_req: Request, { params }: Params) => {
  const userId = requireUserId();
  const session = await prisma.expenseSession.findFirst({ where: { id: params.id, userId } });
  if (!session) return error("Session not found", 404);
  if (session.approvalStatus === "submitted") return error("Already submitted", 409);
  if (session.approvalStatus === "approved") return error("Already approved", 409);

  const updated = await prisma.expenseSession.update({
    where: { id: session.id },
    data: {
      approvalStatus: "submitted",
      submittedAt: new Date(),
      approvedAt: null,
      approvedById: null,
      approvalNote: null,
    },
  });
  return json({ id: updated.id, approvalStatus: updated.approvalStatus });
});
