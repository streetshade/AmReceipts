import { redirect, notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { loadSession } from "@/lib/sessions";
import { toSessionDTO } from "@/lib/dto";
import AppHeader from "@/components/AppHeader";
import SessionClient from "./SessionClient";

export const dynamic = "force-dynamic";

export default async function SessionPage({ params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const session = await loadSession(params.id, user.id);
  if (!session) notFound();

  return (
    <>
      <AppHeader userName={user.name} />
      <main className="mx-auto max-w-4xl px-4 py-6">
        <SessionClient initial={toSessionDTO(session)} />
      </main>
    </>
  );
}
