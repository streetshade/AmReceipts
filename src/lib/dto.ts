import type { LoadedSession } from "./sessions";

// Serializable shapes handed to client components (Dates -> ISO strings).

export interface LineItemDTO {
  id: string;
  description: string;
  quantity: number;
  amount: number;
  linkedScannedItemId: string | null;
}

/** One tax line on a receipt: GST, PST, HST, QST or a US sales tax. */
export interface ReceiptTaxDTO {
  code: string;
  /** Parts per million: 5% is 50000. */
  ratePpm: number | null;
  amount: number;
}

export interface ReceiptDTO {
  id: string;
  /**
   * The id the device minted when the shutter fired.
   *
   * Carried through so the review screen can line a burst of photographs up
   * against the receipts they became - including the ones that are still in the
   * offline queue and have no receipt yet.
   */
  captureId: string | null;
  imagePath: string | null;
  merchant: string | null;
  purchaseDate: string | null;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  paymentRaw: string | null;
  paymentLabel: string | null;
  status: string;
  /** Where the receipt was issued - per receipt, since a technician crosses the border. */
  country: string | null;
  region: string | null;
  /** The tax total broken into its parts. Empty when it has not been split. */
  taxes: ReceiptTaxDTO[];
  lineItems: LineItemDTO[];
}

export interface ScannedItemDTO {
  id: string;
  barcode: string;
  name: string;
  quantity: number;
  imageUrl: string | null;
  brand: string | null;
  price: number | null;
  lineItemId: string | null;
  linkedDescription: string | null;
}

export interface SessionDTO {
  id: string;
  name: string;
  status: string;
  jobNumber: string | null;
  jobName: string | null;
  reasonType: string | null;
  reasonNote: string | null;
  approvalStatus: string;
  approvalNote: string | null;
  approvedByName: string | null;
  submittedAt: string | null;
  receipts: ReceiptDTO[];
  scannedItems: ScannedItemDTO[];
  receiptTotal: number;
}

export function toSessionDTO(s: LoadedSession): SessionDTO {
  return {
    id: s.id,
    name: s.name,
    status: s.status,
    jobNumber: s.job?.number ?? null,
    jobName: s.job?.name ?? null,
    reasonType: s.reasonType,
    reasonNote: s.reasonNote,
    approvalStatus: s.approvalStatus,
    approvalNote: s.approvalNote,
    approvedByName: s.approvedBy?.name ?? null,
    submittedAt: s.submittedAt ? s.submittedAt.toISOString() : null,
    receiptTotal: s.receipts.reduce((acc, r) => acc + (r.total ?? 0), 0),
    receipts: s.receipts.map((r) => ({
      id: r.id,
      captureId: r.captureId,
      imagePath: r.imagePath,
      merchant: r.merchant,
      purchaseDate: r.purchaseDate ? r.purchaseDate.toISOString() : null,
      subtotal: r.subtotal,
      tax: r.tax,
      total: r.total,
      paymentRaw: r.paymentRaw,
      paymentLabel: r.paymentMethod?.label ?? null,
      status: r.status,
      country: r.country,
      region: r.region,
      taxes: r.taxes.map((t) => ({ code: t.code, ratePpm: t.ratePpm, amount: t.amount })),
      lineItems: r.lineItems.map((li) => ({
        id: li.id,
        description: li.description,
        quantity: li.quantity,
        amount: li.amount,
        linkedScannedItemId: li.scannedItem?.id ?? null,
      })),
    })),
    scannedItems: s.scannedItems.map((si) => ({
      id: si.id,
      barcode: si.barcode,
      name: si.name,
      quantity: si.quantity,
      imageUrl: si.product?.imageUrl ?? null,
      brand: si.product?.brand ?? null,
      price: si.product?.price ?? null,
      lineItemId: si.lineItemId,
      linkedDescription: si.lineItem?.description ?? null,
    })),
  };
}
