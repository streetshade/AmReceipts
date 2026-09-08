import { z } from "zod";
import { prisma } from "@/lib/db";
import { handler, json, error, requireUserId } from "@/lib/api";
import { forgetUploads } from "@/lib/uploads";
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
  // Read the photographs BEFORE the cascade removes the rows that name them.
  // Deleting a visit used to take its receipts and leave every image on disk
  // with nothing left pointing at it.
  const images = await prisma.receipt.findMany({
    where: { sessionId: params.id },
    select: { imagePath: true },
  });
  await prisma.expenseSession.delete({ where: { id: params.id } });
  await forgetUploads(images.map((r) => r.imagePath));
  return json({ ok: true });
});
