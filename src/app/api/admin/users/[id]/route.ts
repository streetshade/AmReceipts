import { z } from "zod";
import { prisma } from "@/lib/db";
import { handler, json, error, requireRole } from "@/lib/api";

type Params = { params: { id: string } };

const Body = z.object({
  role: z.enum(["user", "approver", "admin"]).optional(),
  active: z.boolean().optional(),
  company: z.string().max(160).nullable().optional(),
  title: z.string().max(160).nullable().optional(),
  groupId: z.string().nullable().optional(),
});

// Admin: administer any account's access (role, active state, group) and record.
export const PATCH = handler(async (req: Request, { params }: Params) => {
  const admin = await requireRole("admin");
  const target = await prisma.user.findUnique({ where: { id: params.id } });
  if (!target) return error("User not found", 404);

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return error("Invalid input", 422);
  const data = parsed.data;

  // Guard: an admin can't demote or deactivate themselves (avoids lockout).
  if (target.id === admin.id) {
    if (data.role && data.role !== "admin") return error("You cannot change your own role", 409);
    if (data.active === false) return error("You cannot deactivate yourself", 409);
  }

  if (data.groupId) {
    const group = await prisma.group.findUnique({ where: { id: data.groupId } });
    if (!group) return error("Group not found", 422);
  }

  const updated = await prisma.user.update({
    where: { id: target.id },
    data: {
      role: data.role,
      active: data.active,
      company: data.company,
      title: data.title,
      groupId: data.groupId === undefined ? undefined : data.groupId,
    },
    select: { id: true, role: true, active: true, company: true, title: true, groupId: true },
  });
  return json({ user: updated });
});
