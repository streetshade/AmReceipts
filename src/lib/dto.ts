import type { LoadedSession } from "./sessions";

// Serializable shapes handed to client components (Dates -> ISO strings).

export interface LineItemDTO {
  id: string;
  description: string;
  quantity: number;
  amount: number;
  linkedScannedItemId: string | null;
}

export interface ReceiptDTO {
  id: string;
  imagePath: string | null;
  merchant: string | null;
  purchaseDate: string | null;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  paymentRaw: string | null;
  paymentLabel: string | null;
  status: string;
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
    receiptTotal: s.receipts.reduce((acc, r) => acc + (r.total ?? 0), 0),
    receipts: s.receipts.map((r) => ({
      id: r.id,
      imagePath: r.imagePath,
      merchant: r.merchant,
      purchaseDate: r.purchaseDate ? r.purchaseDate.toISOString() : null,
      subtotal: r.subtotal,
      tax: r.tax,
      total: r.total,
      paymentRaw: r.paymentRaw,
      paymentLabel: r.paymentMethod?.label ?? null,
      status: r.status,
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
