import { ReplyPacingSchema, type ReplyPacing } from "@agendia/domain";
import type { Db } from "./shared.ts";

export async function updateResponseTiming(db: Db, responseTiming: ReplyPacing): Promise<ReplyPacing> {
  const policy = ReplyPacingSchema.parse(responseTiming);
  const [row] = await db<ReplyPacing[]>`
      update operational_controls set initial_delay_seconds=${policy.initialDelaySeconds},
        active_delay_seconds=${policy.activeDelaySeconds}, inactivity_reset_seconds=${policy.inactivityResetSeconds}
      where singleton returning initial_delay_seconds "initialDelaySeconds", active_delay_seconds "activeDelaySeconds",
        inactivity_reset_seconds "inactivityResetSeconds"`;
  if (!row) throw new Error("Global reply pacing singleton missing");
  return ReplyPacingSchema.parse(row);
}
export async function globalReplyPacing(db: Db): Promise<ReplyPacing> {
  const [row] = await db<ReplyPacing[]>`
      select initial_delay_seconds "initialDelaySeconds", active_delay_seconds "activeDelaySeconds",
        inactivity_reset_seconds "inactivityResetSeconds" from operational_controls where singleton`;
  if (!row) throw new Error("Global reply pacing singleton missing");
  return ReplyPacingSchema.parse(row);
}
export function saveAgent(db: Db, businessId: string, active: boolean) {
  return db`insert into agent_configs (business_id,active) values (${businessId},${active}) on conflict (business_id) do update set active=excluded.active,revision=agent_configs.revision+1,updated_at=now()`;
}
export async function agent(db: Db) {
  return (
    (
      await db`select style,business_instructions "businessInstructions",active,revision from agent_configs limit 1`
    )[0] ?? null
  );
}
export async function saveFullAgent(
  db: Db,
  businessId: string,
  p: Record<string, unknown>,
  expected: number,
) {
  return (
    (
      await db`insert into agent_configs(business_id,style,business_instructions,active,revision) values(${businessId},${p.style as string},${p.businessInstructions as string},${p.active as boolean},1) on conflict(business_id) do update set style=excluded.style,business_instructions=excluded.business_instructions,active=excluded.active,revision=agent_configs.revision+1,updated_at=now() where agent_configs.revision=${expected} returning style,business_instructions "businessInstructions",active,revision`
    )[0] ?? null
  );
}
