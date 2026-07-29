"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: string;
  active: boolean;
  company: string | null;
  title: string | null;
  groupId: string | null;
}

export interface AdminGroup {
  id: string;
  name: string;
  approverId: string | null;
  approverName: string | null;
  memberCount: number;
}

export default function AdminClient({
  users,
  groups,
  currentUserId,
}: {
  users: AdminUser[];
  groups: AdminGroup[];
  currentUserId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [newGroup, setNewGroup] = useState("");

  const approvers = users.filter((u) => u.role === "approver" || u.role === "admin");

  async function patchUser(id: string, body: Record<string, unknown>) {
    setBusy(id);
    const res = await fetch(`/api/admin/users/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(null);
    if (res.ok) router.refresh();
    else {
      const d = await res.json().catch(() => ({}));
      alert(d.error ?? "Update failed");
      router.refresh();
    }
  }

  async function patchGroup(id: string, body: Record<string, unknown>) {
    setBusy(id);
    await fetch(`/api/admin/groups/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(null);
    router.refresh();
  }

  async function createGroup(e: React.FormEvent) {
    e.preventDefault();
    if (!newGroup.trim()) return;
    setBusy("new-group");
    await fetch("/api/admin/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newGroup.trim() }),
    });
    setBusy(null);
    setNewGroup("");
    router.refresh();
  }

  async function deleteGroup(id: string) {
    if (!confirm("Delete this group? Members will be unassigned.")) return;
    setBusy(id);
    await fetch(`/api/admin/groups/${id}`, { method: "DELETE" });
    setBusy(null);
    router.refresh();
  }

  return (
    <div className="space-y-8">
      {/* Groups */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Groups</h2>
        <div className="card divide-y divide-line">
          {groups.length === 0 && <p className="p-4 text-sm text-muted">No groups yet.</p>}
          {groups.map((g) => (
            <div key={g.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <div className="font-medium">{g.name}</div>
                <div className="text-xs text-muted">
                  {g.memberCount} member{g.memberCount === 1 ? "" : "s"}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs text-muted">Approver</label>
                <select
                  className="rounded border border-line bg-panel2 px-2 py-1 text-sm text-content"
                  value={g.approverId ?? ""}
                  disabled={busy === g.id}
                  onChange={(e) => patchGroup(g.id, { approverId: e.target.value || null })}
                >
                  <option value="">— none —</option>
                  {approvers.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                <button className="text-xs text-muted hover:text-red-300" onClick={() => deleteGroup(g.id)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
        <form onSubmit={createGroup} className="flex gap-2">
          <input
            className="input"
            placeholder="New group name (e.g. Warehouse Team)"
            value={newGroup}
            onChange={(e) => setNewGroup(e.target.value)}
          />
          <button className="btn-secondary shrink-0" disabled={busy === "new-group" || !newGroup.trim()}>
            Add group
          </button>
        </form>
      </section>

      {/* Users */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Accounts ({users.length})</h2>
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">User</th>
                <th className="px-3 py-2 font-medium">Title</th>
                <th className="px-3 py-2 font-medium">Role</th>
                <th className="px-3 py-2 font-medium">Group</th>
                <th className="px-3 py-2 font-medium">Active</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {users.map((u) => {
                const isSelf = u.id === currentUserId;
                return (
                  <tr key={u.id} className={busy === u.id ? "opacity-50" : ""}>
                    <td className="px-3 py-2">
                      <div className="font-medium">{u.name}</div>
                      <div className="text-xs text-muted">{u.email}</div>
                    </td>
                    <td className="px-3 py-2">
                      <input
                        className="w-32 rounded border border-line bg-panel2 px-2 py-1 text-sm text-content"
                        defaultValue={u.title ?? ""}
                        placeholder="—"
                        onBlur={(e) => {
                          const v = e.target.value.trim();
                          if (v !== (u.title ?? "")) patchUser(u.id, { title: v || null });
                        }}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <select
                        className="rounded border border-line bg-panel2 px-2 py-1 text-sm text-content disabled:opacity-50"
                        value={u.role}
                        disabled={isSelf}
                        title={isSelf ? "You cannot change your own role" : undefined}
                        onChange={(e) => patchUser(u.id, { role: e.target.value })}
                      >
                        <option value="user">Basic user</option>
                        <option value="approver">Approver</option>
                        <option value="admin">Administrator</option>
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      <select
                        className="rounded border border-line bg-panel2 px-2 py-1 text-sm text-content"
                        value={u.groupId ?? ""}
                        onChange={(e) => patchUser(u.id, { groupId: e.target.value || null })}
                      >
                        <option value="">— none —</option>
                        {groups.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-brand disabled:opacity-50"
                        checked={u.active}
                        disabled={isSelf}
                        onChange={(e) => patchUser(u.id, { active: e.target.checked })}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
