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

/** Group ids whose reason catalog a user may manage (admin: all; approver: overseen). */
export async function manageableGroupIds(user: { id: string; role: string }): Promise<string[]> {
  if (user.role === "admin") {
    const groups = await prisma.group.findMany({ select: { id: true } });
    return groups.map((g) => g.id);
  }
  if (user.role === "approver") {
    const groups = await prisma.group.findMany({ where: { approverId: user.id }, select: { id: true } });
    return groups.map((g) => g.id);
  }
  return [];
}

/**
 * Whether a user may create/edit a reason with the given group scope.
 * - global reasons (groupId null): admin only
 * - group reasons: admin, or the approver who oversees that group
 */
export async function canManageReason(user: { id: string; role: string }, groupId: string | null): Promise<boolean> {
  if (user.role === "admin") return true;
  if (groupId == null) return false;
  return (await manageableGroupIds(user)).includes(groupId);
}

/** Active reasons a user may attach to a session: global + their own group's. */
export async function availableReasons(user: { id: string; groupId: string | null }) {
  return prisma.reason.findMany({
    where: {
      active: true,
      OR: [{ groupId: null }, ...(user.groupId ? [{ groupId: user.groupId }] : [])],
    },
    orderBy: [{ label: "asc" }],
  });
}
