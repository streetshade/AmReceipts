import { prisma } from "./db";

// Role helpers for the approver/admin oversight model.

/** IDs of the basic users an approver oversees (members of their groups). */
export async function overseenUserIds(approverId: string): Promise<string[]> {
  const groups = await prisma.group.findMany({
    where: { approverId },
    select: { members: { select: { id: true } } },
  });
  return groups.flatMap((g) => g.members.map((m) => m.id));
}

/**
 * The set of user IDs a viewer may report on / approve for.
 * - admin: everyone
 * - approver: the members of the groups they oversee
 * - user: just themselves
 */
export async function reportableUserIds(user: { id: string; role: string }): Promise<string[]> {
  if (user.role === "admin") {
    const all = await prisma.user.findMany({ select: { id: true } });
    return all.map((u) => u.id);
  }
  if (user.role === "approver") {
    return [...new Set([user.id, ...(await overseenUserIds(user.id))])];
  }
  return [user.id];
}

/** Whether an approver/admin may act on a given owner's expenses. */
export async function canOversee(actor: { id: string; role: string }, ownerId: string): Promise<boolean> {
  if (actor.role === "admin") return true;
  if (actor.id === ownerId) return true;
  if (actor.role !== "approver") return false;
  return (await overseenUserIds(actor.id)).includes(ownerId);
}
