import { LivePanel } from "../../src/shell/live-panel";

export default async function Login({ searchParams }: { searchParams: Promise<{ registro?: string | string[] }> }) {
  const params = await searchParams;
  return <LivePanel mode="login" registrationPending={params.registro === "pendiente"} />;
}
