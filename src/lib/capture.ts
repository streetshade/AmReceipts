// One photograph from a capture burst.
//
// Lives in its own module because the camera screen produces these and the
// review screen consumes them, and importing the type across would make the
// two files import each other.

export interface CaptureShot {
  /**
   * Minted on the device when the shutter fires, and sent as the upload's
   * `captureId`, so the receipt it becomes can be found by it later.
   */
  id: string;
  /**
   * A small JPEG data URL, not an object URL over the full photo.
   *
   * Holding the full-resolution Blob alive for every thumbnail exhausted phone
   * memory across a long burst, and object URLs then had to be revoked at
   * exactly the right moment or thumbnails went blank. A 140px preview costs a
   * few kilobytes and has no lifecycle at all. Empty for a PDF, which cannot be
   * shown in an <img>.
   */
  preview: string;
  status: "uploading" | "read" | "queued" | "failed";
  /**
   * The receipt this photograph became, once it has.
   *
   * Without it, deleting a tile whose upload had already succeeded planned a
   * local removal: the tile vanished, the receipt stayed on the visit, and the
   * total went on including a photograph the user had thrown away.
   */
  receiptId: string | null;
  totalCents: number | null;
  merchant: string | null;
  message?: string;
}
