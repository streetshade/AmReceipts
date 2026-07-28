"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

export default function AppHeader({ userName }: { userName: string }) {
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
    { href: "/account", label: "Account" },
  ];

  return (
    <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/90 backdrop-blur">
      <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3">
        <Link href="/dashboard" className="text-lg font-bold text-brand">
          AmReceipts
        </Link>
        <nav className="flex items-center gap-1">
          {links.map((l) => {
            const active = pathname === l.href || pathname.startsWith(l.href + "/");
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                  active ? "bg-brand/10 text-brand" : "text-slate-600 hover:bg-slate-100"
                }`}
              >
                {l.label}
              </Link>
            );
          })}
          <span className="mx-2 hidden text-sm text-slate-400 sm:inline">{userName}</span>
          <button onClick={logout} className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-500 hover:bg-slate-100">
            Sign out
          </button>
        </nav>
      </div>
    </header>
  );
}
