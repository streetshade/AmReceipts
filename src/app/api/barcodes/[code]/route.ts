import { handler, json, error, requireUserId } from "@/lib/api";
import { getBarcodeProvider } from "@/lib/providers/barcode";

type Params = { params: { code: string } };

// Look up a barcode (local seeded DB, or online per BARCODE_PROVIDER). Used by
// the scanner UI to preview the product and its image before adding.
export const GET = handler(async (_req: Request, { params }: Params) => {
  requireUserId();
  const code = decodeURIComponent(params.code).trim();
  if (!/^\d{6,14}$/.test(code)) return error("Not a valid barcode", 422);

  const info = await getBarcodeProvider().lookup(code);
  if (!info) return json({ found: false, barcode: code });
  return json({ found: true, product: info });
});
