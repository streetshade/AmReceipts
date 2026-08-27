import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { reportableUserIds } from "@/lib/access";
import { queryAudit, auditSummary, auditJobNumbers, auditUsers } from "@/lib/m3/audit";
import AppHeader from "@/components/AppHeader";
import PostingsClient from "./PostingsClient";

export const dynamic = "force-dynamic";

// The M3 posting audit trail. Visible to everyone, scoped by role: a basic user
// sees their own postings, an approver their groups', an admin all of them.
export default async function PostingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  // An admin is scoped by "all rows", not "all current users": a posting whose
  // claimant has since been deleted must not drop out of the audit trail.
  const allUsers = user.role === "admin";
  const userIds = allUsers ? [] : await reportableUserIds(user);
  const filters = { allUsers, userIds };

  const [page, summary, jobNumbers, users] = await Promise.all([
    queryAudit(filters),
    auditSummary(filters),
    auditJobNumbers(userIds, allUsers),
    auditUsers(userIds, allUsers),
  ]);

  return (
    <>
      <AppHeader userName={user.name} role={user.role} />
      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6">
        <div>
          <h1 className="text-xl font-semibold">M3 postings</h1>
          <p className="text-sm text-muted">
            Every posting attempted against M3, for checking the ledger against what this app sent.
          </p>
        </div>
        <PostingsClient
          initialRows={page.rows}
          initialCursor={page.nextCursor}
          initialSummary={summary}
          jobNumbers={jobNumbers}
          users={users}
          canFilterUsers={user.role === "approver" || user.role === "admin"}
        />
      </main>
    </>
  );
}
