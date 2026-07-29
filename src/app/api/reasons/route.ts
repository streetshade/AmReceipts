import { z } from "zod";
import { prisma } from "@/lib/db";
import { handler, json, error, requireUser } from "@/lib/api";
import { availableReasons, manageableGroupIds, canManageReason } from "@/lib/access";

export const dynamic = "force-dynamic";

// GET: reasons the current user can attach to a session (global + their group's).
// GET ?manage=1: reasons the current user can manage (for approver/admin UIs).
export const GET = handler(async (req: Request) => {
  const user = await requireUser();
  const manage = new URL(req.url).searchParams.get("manage") === "1";

  if (manage) {
    if (user.role !== "admin" && user.role !== "approver") return error("Forbidden", 403);
    const groupIds = await manageableGroupIds(user);
    const reasons = await prisma.reason.findMany({
      where: user.role === "admin" ? {} : { groupId: { in: groupIds } },
      orderBy: [{ label: "asc" }],
      include: { group: { select: { name: true } } },
    });
    return json({ reasons });
  }

  return json({ reasons: await availableReasons(user) });
});

const CreateBody = z.object({
  label: z.string().min(1).max(120),
  groupId: z.string().nullable().optional(),
});

// Create a reason. Admin: any group or global. Approver: only their groups.
export const POST = handler(async (req: Request) => {
  const user = await requireUser();
  const parsed = CreateBody.safeParse(await req.json());
  if (!parsed.success) return error("A label is required", 422);
  const groupId = parsed.data.groupId ?? null;

  if (!(await canManageReason(user, groupId))) return error("Not authorized for this scope", 403);
  if (groupId) {
    const group = await prisma.group.findUnique({ where: { id: groupId } });
    if (!group) return error("Group not found", 422);
  }

  try {
    const reason = await prisma.reason.create({ data: { label: parsed.data.label.trim(), groupId } });
    return json({ reason }, 201);
  } catch {
    return error("A reason with that label already exists in this scope", 409);
  }
});
