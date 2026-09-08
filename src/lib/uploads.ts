import { promises as fs } from "fs";
import path from "path";

// Removing a stored upload from disk.
//
// Deleting a receipt row and leaving its photograph behind is a slow leak: the
// files are the largest thing this app writes, and nothing ever went back for
// them. A test run of a few dozen captures left thirty-four orphans.

const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads");

/**
 * Delete a stored upload, best-effort.
 *
 * Best-effort, and always AFTER the row is gone: a file that will not unlink
 * must never make a deletion fail, because then the receipt stays on the visit
 * and the user's only recourse is to try again forever. An orphaned row is a
 * problem; an orphaned file is a few hundred kilobytes.
 *
 * Every upload is written under a fresh UUID name, so no two receipts share a
 * file and removing one cannot blank another.
 */
export async function forgetUpload(imagePath: string | null | undefined): Promise<void> {
  if (!imagePath) return;
  const target = path.join(UPLOAD_DIR, imagePath.replace(/^\/uploads\//, ""));
  // The same containment check the file server uses. `imagePath` comes out of
  // the database, but it got there from a request once.
  if (!target.startsWith(UPLOAD_DIR + path.sep)) return;
  try {
    await fs.unlink(target);
  } catch {
    /* already gone, or not ours to remove */
  }
}

/** The same, for a whole visit's worth. */
export async function forgetUploads(imagePaths: (string | null)[]): Promise<void> {
  await Promise.all(imagePaths.map((p) => forgetUpload(p)));
}
