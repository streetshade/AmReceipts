import Link from "next/link";
import { formatCents } from "@/lib/money";
import type { VisitCard } from "@/lib/homeSummary";

/**
 * One job visit, as it appears on Home and on Visits.
 *
 * Shared so the two lists cannot drift into looking like different objects.
 *
 * One deliberate departure from the design, which specifies a gold dot on Home
 * and a neutral one on Visits: the dot follows the STATUS instead. Visits shows
 * approved and sent-back visits too, and a gold "needs attention" dot beside
 * "Approved" says the opposite of the words next to it.
 */
const DOT: Record<VisitCard["status"], string> = {
  collecting: "bg-field-warnDot",
  waiting: "bg-field-warnDot",
  approved: "bg-field-successText",
  "sent-back": "bg-[#B3574F]",
};

export default function VisitCardLink({ visit }: { visit: VisitCard }) {
  return (
    <Link
      href={`/sessions/${visit.id}`}
      className="flex items-center justify-between gap-3 rounded-[16px] border border-field-line bg-field-paper p-4 transition hover:border-field-teal"
    >
      <span className="min-w-0">
        <span className="block truncate text-f-19 font-bold">{visit.title}</span>
        <span className="block text-f-15 text-field-muted">{visit.meta}</span>
        <span className="mt-2 inline-flex items-center gap-2 rounded-full border border-field-line bg-field-ground px-2.5 py-1 text-f-14 font-semibold text-field-muted">
          <span aria-hidden className={`block h-2 w-2 rounded-full ${DOT[visit.status]}`} />
          {visit.statusLabel}
        </span>
      </span>
      <span className="shrink-0 text-right">
        <span className="block text-f-21 font-bold tabular-nums">{formatCents(visit.totalCents)}</span>
        <span className="block text-f-15 font-semibold text-field-teal">Open ›</span>
      </span>
    </Link>
  );
}
