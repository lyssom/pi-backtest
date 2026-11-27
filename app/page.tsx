import { Suspense } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { getResearchAccess, isResearchRequest } from "@/lib/backtest/research-access";
import { I18nProvider } from "@/hooks/useI18n";

// Select the research entry at request time, not from build-time credentials.
export const dynamic = "force-dynamic";

export default async function Home() {
  const research = getResearchAccess();
  if (research && isResearchRequest(await headers(), research)) redirect("/research");
  return (
    <Suspense>
      <I18nProvider>
        <AppShell />
      </I18nProvider>
    </Suspense>
  );
}
