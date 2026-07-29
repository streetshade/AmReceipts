"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Logo } from "./Logo";

export default function AppHeader({ userName, role = "user" }: { userName: string; role?: string }) {
  const router = useRouter();
  const pathname = usePathname();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  const links = [
    { href: "/dashboard", label: "Sessions" },
    { href: "/reports", label: "Reports" },
    // Approvers (and admins) get the approvals queue.
    ...(role === "approver" || role === "admin" ? [{ href: "/approvals", label: "Approvals" }] : []),
    // Admins get account administration.
    ...(role === "admin" ? [{ href: "/admin", label: "Admin" }] : []),
    { href: "/account", label: "Account" },
  ];

  return (
    <header className="sticky top-0 z-10 border-b border-line bg-ink/85 backdrop-blur">
      <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3">
        <Link href="/dashboard" className="flex items-center gap-2" aria-label="Samaritech AmReceipts">
          <Logo className="h-7" />
          <span className="hidden text-sm font-semibold text-muted sm:inline">AmReceipts</span>
        </Link>
        <nav className="flex items-center gap-1">
          {links.map((l) => {
            const active = pathname === l.href || pathname.startsWith(l.href + "/");
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                  active ? "bg-brand/15 text-brand" : "text-muted hover:bg-panel2 hover:text-content"
                }`}
              >
                {l.label}
              </Link>
            );
          })}
          <span className="mx-2 hidden text-sm text-muted sm:inline">{userName}</span>
          <button onClick={logout} className="rounded-lg px-3 py-1.5 text-sm font-medium text-muted hover:bg-panel2 hover:text-content">
            Sign out
          </button>
        </nav>
      </div>
    </header>
  );
}
