"use client";

// The five-tab bar the design puts under Home, Visits, Spend, Approve and You.
//
// Two honest notes about what these currently reach:
//
//  - Spend, Approve and You still land on the desktop screens. They work; they
//    have not been redesigned yet. A tab that goes somewhere plain beats a tab
//    that goes nowhere, and the alternative - hiding them until their screens
//    exist - leaves Home with no navigation at all.
//  - Approve is shown only to approvers and admins. The design's persona is an
//    approver; a technician who taps it would get a 403, so they do not get it.

import Link from "next/link";
import { usePathname } from "next/navigation";

interface Tab {
  href: string;
  label: string;
  /** The mark inside the 22px glyph square, so five tabs are not five squares. */
  glyph: "home" | "list" | "bars" | "tick" | "person";
}

function Glyph({ kind, active }: { kind: Tab["glyph"]; active: boolean }) {
  const stroke = active ? "border-field-teal" : "border-field-muted";
  const fill = active ? "bg-field-teal" : "bg-field-muted";
  return (
    <span
      aria-hidden
      className={`relative flex h-[22px] w-[22px] items-center justify-center rounded-[6px] border-[2.5px] ${stroke}`}
    >
      {kind === "home" && <span className={`block h-[6px] w-[6px] rounded-[1px] ${fill}`} />}
      {kind === "list" && (
        <span className="flex w-[10px] flex-col gap-[2px]">
          <span className={`block h-[2px] w-full ${fill}`} />
          <span className={`block h-[2px] w-full ${fill}`} />
        </span>
      )}
      {kind === "bars" && (
        <span className="flex h-[10px] items-end gap-[2px]">
          <span className={`block h-[4px] w-[2px] ${fill}`} />
          <span className={`block h-[8px] w-[2px] ${fill}`} />
          <span className={`block h-[6px] w-[2px] ${fill}`} />
        </span>
      )}
      {kind === "tick" && (
        <span
          className={`block h-[4px] w-[8px] rotate-[-45deg] border-b-[2.5px] border-l-[2.5px] ${stroke}`}
        />
      )}
      {kind === "person" && (
        <span className="flex flex-col items-center gap-[1px]">
          <span className={`block h-[5px] w-[5px] rounded-full ${fill}`} />
          <span className={`block h-[3px] w-[9px] rounded-t-full ${fill}`} />
        </span>
      )}
    </span>
  );
}

export default function FieldTabBar({ role = "user" }: { role?: string }) {
  const pathname = usePathname();
  const tabs: Tab[] = [
    { href: "/dashboard", label: "Home", glyph: "home" },
    { href: "/dashboard/visits", label: "Visits", glyph: "list" },
    { href: "/reports", label: "Spend", glyph: "bars" },
    ...(role === "approver" || role === "admin"
      ? [{ href: "/approvals", label: "Approve", glyph: "tick" } as Tab]
      : []),
    { href: "/account", label: "You", glyph: "person" },
  ];

  return (
    <nav className="z-10 flex shrink-0 border-t border-field-line bg-field-paper px-2 pb-[calc(env(safe-area-inset-bottom)+10px)] pt-1.5">
      {tabs.map((t) => {
        // Exact match only. `startsWith` would light Home up on every
        // /dashboard/* route, including Visits.
        const active = pathname === t.href;
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className="flex h-[52px] flex-1 flex-col items-center justify-center gap-0.5"
          >
            <Glyph kind={t.glyph} active={active} />
            <span className={`text-f-12 font-semibold ${active ? "text-field-teal" : "text-field-muted"}`}>
              {t.label}
            </span>
            <span
              aria-hidden
              className={`block h-[3px] w-5 rounded-full ${active ? "bg-field-teal" : "bg-transparent"}`}
            />
          </Link>
        );
      })}
    </nav>
  );
}
