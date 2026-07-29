import { z } from "zod";
import { prisma } from "@/lib/db";
import { handler, json, error, requireRole } from "@/lib/api";

export const GET = handler(async () => {
  await requireRole("admin");
  const groups = await prisma.group.findMany({
    orderBy: { name: "asc" },
    include: { approver: { select: { id: true, name: true } }, _count: { select: { members: true } } },
  });
  return json({ groups });
});

const CreateBody = z.object({
  name: z.string().min(1).max(120),
  approverId: z.string().nullable().optional(),
});

// Admin: create a group and optionally assign an approver.
export const POST = handler(async (req: Request) => {
  await requireRole("admin");
  const parsed = CreateBody.safeParse(await req.json());
  if (!parsed.success) return error("A group name is required", 422);
  const { name, approverId } = parsed.data;

  if (approverId) {
    const approver = await prisma.user.findUnique({ where: { id: approverId } });
    if (!approver) return error("Approver not found", 422);
  }

  try {
    const group = await prisma.group.create({ data: { name, approverId: approverId ?? null } });
    return json({ group }, 201);
  } catch {
    return error("A group with that name already exists", 409);
  }
});
