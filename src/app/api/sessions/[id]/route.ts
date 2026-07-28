import { z } from "zod";
import { prisma } from "@/lib/db";
import { handler, json, error, requireUserId } from "@/lib/api";
import { loadSession } from "@/lib/sessions";

type Params = { params: { id: string } };

export const GET = handler(async (_req: Request, { params }: Params) => {
  const userId = requireUserId();
  const session = await loadSession(params.id, userId);
  if (!session) return error("Session not found", 404);
  return json({ session });
});

const PatchBody = z.object({
  name: z.string().min(1).max(120).optional(),
  status: z.enum(["open", "assigned", "closed"]).optional(),
});

export const PATCH = handler(async (req: Request, { params }: Params) => {
  const userId = requireUserId();
  const owned = await prisma.expenseSession.findFirst({ where: { id: params.id, userId } });
  if (!owned) return error("Session not found", 404);
  const parsed = PatchBody.safeParse(await req.json());
  if (!parsed.success) return error("Invalid input", 422);
  const session = await prisma.expenseSession.update({
    where: { id: params.id },
    data: parsed.data,
  });
  return json({ id: session.id, name: session.name, status: session.status });
});

export const DELETE = handler(async (_req: Request, { params }: Params) => {
  const userId = requireUserId();
  const owned = await prisma.expenseSession.findFirst({ where: { id: params.id, userId } });
  if (!owned) return error("Session not found", 404);
  await prisma.expenseSession.delete({ where: { id: params.id } });
  return json({ ok: true });
});
