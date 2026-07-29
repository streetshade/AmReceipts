import { z } from "zod";
import { prisma } from "@/lib/db";
import { handler, json, error, requireRole } from "@/lib/api";

type Params = { params: { id: string } };

const Body = z.object({
  name: z.string().min(1).max(120).optional(),
  approverId: z.string().nullable().optional(),
});

// Admin: rename a group or (re)assign its approver.
export const PATCH = handler(async (req: Request, { params }: Params) => {
  await requireRole("admin");
  const group = await prisma.group.findUnique({ where: { id: params.id } });
  if (!group) return error("Group not found", 404);

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return error("Invalid input", 422);
  const { name, approverId } = parsed.data;

  if (approverId) {
    const approver = await prisma.user.findUnique({ where: { id: approverId } });
    if (!approver) return error("Approver not found", 422);
  }

  const updated = await prisma.group.update({
    where: { id: group.id },
    data: { name, approverId: approverId === undefined ? undefined : approverId },
  });
  return json({ group: updated });
});

export const DELETE = handler(async (_req: Request, { params }: Params) => {
  await requireRole("admin");
  const group = await prisma.group.findUnique({ where: { id: params.id } });
  if (!group) return error("Group not found", 404);
  // Members are detached (groupId set null) by the schema relation.
  await prisma.group.delete({ where: { id: group.id } });
  return json({ ok: true });
});
