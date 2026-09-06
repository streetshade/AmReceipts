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

export async function enqueue(item: Omit<PendingUpload, "attempts">): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ ...item, attempts: 0 });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
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

export interface FlushResult {
  sent: number;
  remaining: number;
}

/**
 * Try to send everything queued.
 *
 * A receipt is deleted from the queue only on a response from the server -
 * including a rejection, because a photo the server refuses will be refused
 * again and would otherwise retry for ever. A network failure leaves it queued.
 */
export async function flush(onSent?: (item: PendingUpload) => void): Promise<FlushResult> {
  if (!offlineQueueAvailable()) return { sent: 0, remaining: 0 };

  const pending = await listPending();
  let sent = 0;

  for (const item of pending) {
    const form = new FormData();
    form.append("image", item.blob, item.filename);
    try {
      const res = await fetch(`/api/sessions/${item.sessionId}/receipts`, { method: "POST", body: form });
      if (res.ok || (res.status >= 400 && res.status < 500)) {
        await remove(item.id);
        sent++;
        onSent?.(item);
      } else {
        await noteFailure(item, `Server error ${res.status}`);
      }
    } catch {
      // Still offline. Left in the queue for the next attempt.
      await noteFailure(item, "No connection");
    }
  }

  return { sent, remaining: (await listPending()).length };
}
