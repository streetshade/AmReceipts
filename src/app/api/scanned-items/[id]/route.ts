import { z } from "zod";
import { prisma } from "@/lib/db";
import { handler, json, error, requireUserId } from "@/lib/api";

type Params = { params: { id: string } };

async function ownItem(itemId: string, userId: string) {
  return prisma.scannedItem.findFirst({ where: { id: itemId, session: { userId } } });
}

const PatchBody = z.object({
  quantity: z.number().int().min(1).max(9999).optional(),
  // Set to a line item id to link, or null to unlink.
  lineItemId: z.string().nullable().optional(),
});

// Update quantity, or manually link/unlink this item to a receipt line item.
export const PATCH = handler(async (req: Request, { params }: Params) => {
  const userId = requireUserId();
  const item = await ownItem(params.id, userId);
  if (!item) return error("Item not found", 404);

  const parsed = PatchBody.safeParse(await req.json());
  if (!parsed.success) return error("Invalid input", 422);
  const { quantity, lineItemId } = parsed.data;

  if (lineItemId) {
    // The target line item must belong to the same session and be free.
    const line = await prisma.lineItem.findFirst({
      where: { id: lineItemId, receipt: { sessionId: item.sessionId } },
      include: { scannedItem: true },
    });
    if (!line) return error("Line item not found in this session", 422);
    if (line.scannedItem && line.scannedItem.id !== item.id) {
      return error("That line item is already linked to another product", 409);
    }
  }

  const updated = await prisma.scannedItem.update({
    where: { id: item.id },
    data: {
      quantity: quantity ?? undefined,
      lineItemId: lineItemId === undefined ? undefined : lineItemId,
    },
    include: { product: true, lineItem: true },
  });
  return json({ scannedItem: updated });
});

export const DELETE = handler(async (_req: Request, { params }: Params) => {
  const userId = requireUserId();
  const item = await ownItem(params.id, userId);
  if (!item) return error("Item not found", 404);
  await prisma.scannedItem.delete({ where: { id: item.id } });
  return json({ ok: true });
});
