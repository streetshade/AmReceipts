import { z } from "zod";
import { prisma } from "@/lib/db";
import { handler, json, error, requireUserId } from "@/lib/api";
import { getBarcodeProvider } from "@/lib/providers/barcode";
import { bestLineItemMatch, MatchCandidate } from "@/lib/matching";

type Params = { params: { id: string } };

const Body = z.object({
  barcode: z.string().regex(/^\d{6,14}$/, "Not a valid barcode"),
  quantity: z.number().int().min(1).max(9999).default(1),
});

// Add a scanned product to a session. Looks up the product, records it with the
// requested quantity, and auto-links it to a matching receipt line item.
export const POST = handler(async (req: Request, { params }: Params) => {
  const userId = requireUserId();
  const session = await prisma.expenseSession.findFirst({ where: { id: params.id, userId } });
  if (!session) return error("Session not found", 404);

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return error(parsed.error.issues[0]?.message ?? "Invalid input", 422);
  const { barcode, quantity } = parsed.data;

  const info = await getBarcodeProvider().lookup(barcode);
  const product = info ? await prisma.product.findUnique({ where: { barcode } }) : null;
  const name = info?.name ?? `Unknown item (${barcode})`;

  // Attempt to reconcile against still-unlinked receipt line items in this session.
  const unlinked = await prisma.lineItem.findMany({
    where: { receipt: { sessionId: session.id }, scannedItem: null },
    select: { id: true, description: true },
  });
  const candidates: MatchCandidate[] = unlinked.map((l) => ({ lineItemId: l.id, description: l.description }));
  const lineItemId = bestLineItemMatch(name, candidates);

  const scanned = await prisma.scannedItem.create({
    data: {
      sessionId: session.id,
      barcode,
      productId: product?.id ?? null,
      name,
      quantity,
      lineItemId,
    },
    include: { product: true, lineItem: true },
  });

  return json({ scannedItem: scanned, matched: Boolean(lineItemId), found: Boolean(info) }, 201);
});
