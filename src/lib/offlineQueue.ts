"use client";

// A durable queue for captures taken without a usable connection.
//
// Offline-first is a stated requirement of the field design, and it is not
// satisfied by holding a Blob in React state: a refresh, a navigation or the
// browser reclaiming memory loses the photo, and the receipt is gone for good
// because the paper is already in a bin. So a capture that cannot be uploaded
// is written to IndexedDB - which stores Blobs directly - and retried.
//
// IndexedDB rather than localStorage because localStorage is strings only, and
// base64-ing a photo into it both inflates it by a third and blocks the main
// thread while it does so.

const DB_NAME = "amreceipts-offline";
const STORE = "pending-uploads";
const DB_VERSION = 1;

export interface PendingUpload {
  id: string;
  sessionId: string;
  filename: string;
  blob: Blob;
  capturedAt: number;
  attempts: number;
  lastError?: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        // Retried oldest-first, so a receipt is not overtaken by later ones.
        store.createIndex("capturedAt", "capturedAt");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Whether this browser can queue at all. Private modes sometimes cannot. */
export function offlineQueueAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

export interface EnqueueResult {
  /** Older captures dropped to make room. Non-zero means data was lost. */
  evicted: number;
}

/**
 * Queue a capture for later, bounded.
 *
 * Eviction and insertion happen in ONE transaction. Doing them separately
 * meant a failed `put` after a successful delete lost both the evicted receipt
 * AND the new capture, and two concurrent enqueues could each read a count
 * below the cap and both write.
 *
 * A phone out of signal for a week should not fill its storage quota and start
 * failing writes silently. The oldest go first, because the newest capture is
 * the one the user is looking at - and the count is RETURNED, so the caller can
 * say so rather than losing a receipt quietly.
 */
export async function enqueue(item: Omit<PendingUpload, "attempts">): Promise<EnqueueResult> {
  const db = await openDb();
  try {
    const evicted = await new Promise<number>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      let dropped = 0;

      const write = () => store.put({ ...item, attempts: 0 });

      // Counting the store and adding one assumes this is a NEW key. Re-queuing
      // an id already present would otherwise evict a receipt to make room for
      // something that needs none.
      const existingReq = store.count(item.id);
      existingReq.onsuccess = () => {
        const countReq = store.count();
        countReq.onsuccess = () => {
          const replacing = existingReq.result > 0 ? 1 : 0;
          const overflow = countReq.result + 1 - replacing - MAX_QUEUED;
          if (overflow <= 0) {
            write();
            return;
          }
          // Oldest first, via the capturedAt index.
          const cursorReq = store.index("capturedAt").openCursor();
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (cursor && dropped < overflow) {
              cursor.delete();
              dropped++;
              cursor.continue();
            } else {
              write();
            }
          };
        };
      };

      tx.oncomplete = () => resolve(dropped);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return { evicted };
  } finally {
    // Released even when the transaction failed; otherwise a phone with a full
    // quota accumulates open connections on every attempt.
    db.close();
  }
}

export async function listPending(sessionId?: string): Promise<PendingUpload[]> {
  const db = await openDb();
  const all = await new Promise<PendingUpload[]>((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as PendingUpload[]);
    req.onerror = () => reject(req.error);
  });
  db.close();
  const rows = sessionId ? all.filter((r) => r.sessionId === sessionId) : all;
  return rows.sort((a, b) => a.capturedAt - b.capturedAt);
}

export async function remove(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function noteFailure(item: PendingUpload, message: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ ...item, attempts: item.attempts + 1, lastError: message });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/** Most a queue may hold before the oldest are dropped, and a warning shown. */
export const MAX_QUEUED = 60;

export interface FlushResult {
  sent: number;
  remaining: number;
  /** Items abandoned because the server refused them permanently. */
  rejected: number;
}

/**
 * Whether a response means "never going to work" or "try later".
 *
 * Getting this wrong is expensive in both directions: deleting on a 429 throws
 * away a receipt because the server was momentarily busy, and retrying a 413
 * for ever fills the queue with something that can never be sent. An earlier
 * version deleted on ANY 4xx and counted it as sent, which silently discarded
 * receipts on an expired session.
 */
export function isPermanentRejection(status: number): boolean {
  // 400 malformed, 404 the session no longer exists, 413 too large,
  // 415 wrong type, 422 unprocessable. Retrying none of these can help.
  return status === 400 || status === 404 || status === 413 || status === 415 || status === 422;
}

// One flush at a time, process-wide. Mount and the "online" event can fire
// within milliseconds of each other, and two flushes over one queue upload the
// same photo twice.
//
// Listeners are held separately from the promise: a caller that JOINS a running
// flush still needs to hear about its own tiles, and an earlier version simply
// discarded the joiner's callback - so a freshly mounted panel could sit
// showing "queued" for photos that had already been sent.
let inFlight: Promise<FlushResult> | null = null;
const listeners = new Set<(item: PendingUpload, outcome: "sent" | "rejected") => void>();

/**
 * Try to send everything queued.
 *
 * A receipt is deleted from the queue only on a response from the server -
 * including a rejection, because a photo the server refuses will be refused
 * again and would otherwise retry for ever. A network failure leaves it queued.
 */
export async function flush(onSent?: (item: PendingUpload, outcome: "sent" | "rejected") => void): Promise<FlushResult> {
  if (!offlineQueueAvailable()) return { sent: 0, remaining: 0, rejected: 0 };
  // Join the flush already running rather than starting a second one.
  if (onSent) listeners.add(onSent);
  if (inFlight) {
    try {
      return await inFlight;
    } finally {
      if (onSent) listeners.delete(onSent);
    }
  }

  const notify = (item: PendingUpload, outcome: "sent" | "rejected") => {
    for (const l of listeners) {
      try {
        l(item, outcome);
      } catch {
        /* a listener must not take the flush down with it */
      }
    }
  };

  inFlight = (async () => {
    let sent = 0;
    let rejected = 0;

    // Re-read each pass. Work enqueued while a flush is running would
    // otherwise wait for the next mount or "online" event to be noticed.
    for (let pass = 0; pass < 3; pass++) {
      const pending = await listPending();
      if (pending.length === 0) break;
      let progressed = false;

      for (const item of pending) {
        const form = new FormData();
        form.append("image", item.blob, item.filename);
        // The queue's own id is the capture id the first attempt used, so a
        // retry after a lost response is recognised rather than duplicated.
        form.append("captureId", item.id);
        try {
          const res = await fetch(`/api/sessions/${item.sessionId}/receipts`, { method: "POST", body: form });
          if (res.ok) {
            await remove(item.id);
            sent++;
            progressed = true;
            notify(item, "sent");
          } else if (isPermanentRejection(res.status)) {
            // Refused for a reason retrying cannot change. Removed, but
            // reported as rejected rather than sent so it is not silently lost.
            await remove(item.id);
            rejected++;
            progressed = true;
            notify(item, "rejected");
          } else {
            // 401, 408, 429, 5xx: the server may take it later.
            await noteFailure(item, `Server said ${res.status}`);
          }
        } catch {
          // Still offline. Nothing further will succeed this pass either.
          await noteFailure(item, "No connection");
          return { sent, rejected, remaining: (await listPending()).length };
        }
      }

      // Nothing moved, so another pass would repeat the same failures.
      if (!progressed) break;
    }

    return { sent, rejected, remaining: (await listPending()).length };
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
    if (onSent) listeners.delete(onSent);
  }
}
