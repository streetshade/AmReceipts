import { redirect, notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { loadSession } from "@/lib/sessions";
import { toSessionDTO } from "@/lib/dto";
import { getUiVersion } from "@/lib/settings";
import AppHeader from "@/components/AppHeader";
import SessionClient from "./SessionClient";

export const dynamic = "force-dynamic";

export default async function SessionPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { capture?: string };
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const session = await loadSession(params.id, user.id);
  if (!session) notFound();

  const uiVersion = await getUiVersion();

  return (
    <>
      <AppHeader userName={user.name} role={user.role} />
      <main className="mx-auto max-w-4xl px-4 py-6">
        <SessionClient
          initial={toSessionDTO(session)}
          uiVersion={uiVersion}
          // Home opens the camera directly: `Log here` should be one tap to a
          // viewfinder, not one tap to a screen with a button on it.
          startCapturing={searchParams.capture === "1"}
        />
      </main>
    </>
  );
}
