import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getUiVersion } from "@/lib/settings";
import { loadVisitCards } from "@/lib/homeSummary";
import VisitCardLink from "../field/VisitCardLink";
import FieldTabBar from "../field/FieldTabBar";

export const dynamic = "force-dynamic";

// Every job visit, and the only place they are listed. Home used to show the
// few still open above the fold; on a phone that was a second copy of this
// screen one tap away, and it was what pushed the day's figures off the bottom.
export default async function VisitsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  // A field-only screen. With the classic interface selected there is nothing
  // here the dashboard does not already do, so it sends them back rather than
  // serving a page in a style the rest of the site has been switched away from.
  if ((await getUiVersion()) !== "field") redirect("/dashboard");

  const visits = await loadVisitCards(user.id);

  return (
    // Fixed to the viewport with the list scrolling inside it, the same shape
    // as Home. As an ordinary scrolling document the tab bar sat after the last
    // of up to a hundred cards, so the navigation walked off the bottom.
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-field-ground font-field text-field-ink">
      <header className="shrink-0 border-b border-field-line bg-field-paper px-5 pb-4 pt-[calc(env(safe-area-inset-top)+14px)]">
        <p className="text-f-14 font-semibold uppercase tracking-[.08em] text-field-muted">Your work</p>
        <h1 className="text-f-25 font-bold">Job visits</h1>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-5 pb-6 pt-4">
        {visits.length === 0 ? (
          <p className="rounded-[16px] border border-field-line bg-field-paper p-4 text-f-17 text-field-muted">
            No visits yet. Scan a receipt on Home and the first one starts itself.
          </p>
        ) : (
          visits.map((v) => <VisitCardLink key={v.id} visit={v} />)
        )}
      </div>

      <FieldTabBar role={user.role} />
    </div>
  );
}
