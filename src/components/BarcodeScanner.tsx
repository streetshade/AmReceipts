"use client";

import { useEffect, useRef, useState } from "react";
import { BrowserMultiFormatReader, IScannerControls } from "@zxing/browser";

/**
 * Live barcode scanner. Uses the device camera via ZXing; falls back to manual
 * entry (and works on desktops without a camera). Calls onDetected once per
 * accepted scan and briefly pauses to avoid duplicate reads.
 */
export default function BarcodeScanner({ onDetected }: { onDetected: (code: string) => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const lastRef = useRef<{ code: string; at: number }>({ code: "", at: 0 });
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState("");

  async function start() {
    setError(null);
    try {
      const reader = new BrowserMultiFormatReader();
      const controls = await reader.decodeFromVideoDevice(undefined, videoRef.current!, (result) => {
        if (!result) return;
        const code = result.getText().replace(/\D/g, "");
        if (code.length < 6) return;
        const now = Date.now();
        // Debounce identical reads within 2.5s.
        if (lastRef.current.code === code && now - lastRef.current.at < 2500) return;
        lastRef.current = { code, at: now };
        onDetected(code);
      });
      controlsRef.current = controls;
      setScanning(true);
    } catch (e) {
      setError("Could not access the camera. Use manual entry below.");
      setScanning(false);
    }
  }

  function stop() {
    controlsRef.current?.stop();
    controlsRef.current = null;
    setScanning(false);
  }

  // Stop the camera when unmounted.
  useEffect(() => () => stop(), []);

  function submitManual(e: React.FormEvent) {
    e.preventDefault();
    const code = manual.replace(/\D/g, "");
    if (code.length >= 6) {
      onDetected(code);
      setManual("");
    }
  }

  return (
    <div className="space-y-3">
      <div className="relative overflow-hidden rounded-lg bg-black">
        <video ref={videoRef} className="aspect-video w-full object-cover" muted playsInline />
        {!scanning && (
          <div className="absolute inset-0 flex items-center justify-center">
            <button type="button" onClick={start} className="btn-primary">
              Start camera
            </button>
          </div>
        )}
        {scanning && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="h-1/3 w-2/3 rounded-lg border-2 border-brand/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
          </div>
        )}
      </div>

      {scanning && (
        <button type="button" onClick={stop} className="btn-secondary w-full">
          Stop camera
        </button>
      )}
      {error && <p className="text-sm text-amber-300">{error}</p>}

      <form onSubmit={submitManual} className="flex gap-2">
        <input
          className="input"
          inputMode="numeric"
          placeholder="Or type a barcode number"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
        />
        <button className="btn-secondary shrink-0" disabled={manual.replace(/\D/g, "").length < 6}>
          Look up
        </button>
      </form>
    </div>
  );
}
