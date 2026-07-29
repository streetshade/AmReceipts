"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Props {
  name: string;
  email: string;
  role: string;
  company: string | null;
  title: string | null;
  groupName: string | null;
}

const ROLE_LABEL: Record<string, string> = {
  user: "Basic user",
  approver: "Approver",
  admin: "Administrator",
};

// Self-service account record. Role and group are read-only here (admin-managed).
export default function ProfileCard({ name, email, role, company, title, groupName }: Props) {
  const router = useRouter();
  const [form, setForm] = useState({ name, company: company ?? "", title: title ?? "" });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setSaved(false);
    const res = await fetch("/api/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.name.trim(),
        company: form.company.trim() || null,
        title: form.title.trim() || null,
      }),
    });
    setBusy(false);
    if (res.ok) {
      setSaved(true);
      router.refresh();
    }
  }

  return (
    <section className="card overflow-hidden">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <span className="font-semibold">Profile</span>
        <div className="flex items-center gap-2">
          <span className="badge bg-brand/15 text-brand">{ROLE_LABEL[role] ?? role}</span>
          {groupName && <span className="badge bg-panel2 text-muted">{groupName}</span>}
        </div>
      </div>
      <form onSubmit={save} className="grid gap-3 p-4 sm:grid-cols-2">
        <div>
          <label className="label">Name</label>
          <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        </div>
        <div>
          <label className="label">Email</label>
          <input className="input opacity-60" value={email} disabled />
        </div>
        <div>
          <label className="label">Company</label>
          <input
            className="input"
            placeholder="Company name"
            value={form.company}
            onChange={(e) => setForm({ ...form, company: e.target.value })}
          />
        </div>
        <div>
          <label className="label">Title</label>
          <input
            className="input"
            placeholder="Job title"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
        </div>
        <div className="flex items-center gap-3 sm:col-span-2">
          <button className="btn-primary" disabled={busy}>
            {busy ? "Saving…" : "Save profile"}
          </button>
          {saved && <span className="text-sm text-brand">Saved.</span>}
        </div>
      </form>
    </section>
  );
}
