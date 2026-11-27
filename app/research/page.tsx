import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import { I18nProvider } from "@/hooks/useI18n";
import { getResearchAccess, hasResearchSession, isResearchRequest, RESEARCH_COOKIE } from "@/lib/backtest/research-access";
import { ResearchChat } from "./research-chat";

export const metadata = { title: "研究对话 · Pi Backtest" };
export const dynamic = "force-dynamic";

export default async function ResearchPage() {
  const access = getResearchAccess();
  if (!access || !isResearchRequest(await headers(), access)) notFound();
  const authenticated = hasResearchSession((await cookies()).get(RESEARCH_COOKIE)?.value, access);
  return <I18nProvider><ResearchChat initiallyAuthenticated={authenticated} /></I18nProvider>;
}
