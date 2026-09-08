import { prisma } from "@/lib/db";
import { handler, json, error, requireUserId } from "@/lib/api";
import { forgetUpload } from "@/lib/uploads";

export const dynamic = "force-dynamic";

type Params = { params: { id: string; captureId: string } };

/**
 * Throw a photograph away, for good.
 *
 * Addressed by CAPTURE id rather than receipt id, and that is the whole point.
 * The same photograph may be mid-upload or sitting in the phone's offline
 * queue, and neither request can be called back - so deleting the receipt alone
 * leaves the one in the air to recreate it a moment later, on a visit the user
 * has already walked away from. Only the server can close that: it records the
 * capture as discarded, and the upload route refuses anything arriving under
 * that id afterwards.
 *
 * Idempotent. A capture with no receipt yet is still recorded, which is exactly
 * the case that needs it.
 */
export const DELETE = handler(async (_req: Request, { params }: Params) => {
  const userId = requireUserId();
  const session = await prisma.expenseSession.findFirst({
    where: { id: params.id, userId },
    select: { id: true },
  });
  if (!session) return error("Visit not found", 404);

  const captureId = params.captureId.trim();
  if (!captureId) return error("A capture id is required", 422);

  // The tombstone is written and COMMITTED before the receipt is looked for.
  //
  // That ordering is the whole safety argument, and it has to be read together
  // with the upload route, which creates its receipt and only then looks for a
  // tombstone. Each side writes, commits, and then looks for the other. For
  // both to miss, this read would have to happen before the upload's commit
  // while the upload's read happened before this commit - and each read comes
  // after its own commit, so that ordering is impossible. One of the two always
  // sees the other.
  //
  // An earlier version put both statements in one transaction with the
  // tombstone first. That orders them against each other and against nothing
  // else: a POST could check for a tombstone, spend several seconds in OCR,
  // and create its receipt after this had been and gone.
  await prisma.discardedCapture.upsert({
    where: { sessionId_captureId: { sessionId: session.id, captureId } },
    update: {},
    create: { sessionId: session.id, captureId },
  });

  // Scoped to this visit, which the caller has been shown to own. A bare lookup
  // on the unique column would delete any receipt whose capture id could be
  // guessed or replayed, including another user's.
  const receipt = await prisma.receipt.findFirst({
    where: { captureId, sessionId: session.id },
    select: { id: true, imagePath: true },
  });
  if (receipt) {
    await prisma.receipt.delete({ where: { id: receipt.id } });
    // After the row is gone, and never allowed to fail the request.
    await forgetUpload(receipt.imagePath);
  }

  return json({ ok: true, deletedReceipt: Boolean(receipt) });
});
