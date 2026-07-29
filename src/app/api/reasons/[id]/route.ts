import { z } from "zod";
import { prisma } from "@/lib/db";
import { handler, json, error, requireUser } from "@/lib/api";
import { canManageReason } from "@/lib/access";

type Params = { params: { id: string } };

const Body = z.object({
  label: z.string().min(1).max(120).optional(),
  active: z.boolean().optional(),
});

// Edit a reason's label/active state. Authorized for the reason's scope.
export const PATCH = handler(async (req: Request, { params }: Params) => {
  const user = await requireUser();
  const reason = await prisma.reason.findUnique({ where: { id: params.id } });
  if (!reason) return error("Reason not found", 404);
  if (!(await canManageReason(user, reason.groupId))) return error("Forbidden", 403);

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return error("Invalid input", 422);

  const updated = await prisma.reason.update({
    where: { id: reason.id },
    data: { label: parsed.data.label?.trim(), active: parsed.data.active },
  });
  return json({ reason: updated });
});

export const DELETE = handler(async (_req: Request, { params }: Params) => {
  const user = await requireUser();
  const reason = await prisma.reason.findUnique({ where: { id: params.id } });
  if (!reason) return error("Reason not found", 404);
  if (!(await canManageReason(user, reason.groupId))) return error("Forbidden", 403);
  // Sessions referencing it are detached (reasonId → null) by the relation.
  await prisma.reason.delete({ where: { id: reason.id } });
  return json({ ok: true });
});
