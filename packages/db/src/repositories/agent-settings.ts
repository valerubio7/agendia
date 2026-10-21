import { ReplyPacingSchema, type ReplyPacing } from "@agendia/domain";
import type { Db } from "./shared.ts";

type PlatformAiSettingsRow = ReplyPacing & { additionalInstructions: string };
function platformAiSettings(row: PlatformAiSettingsRow | undefined) {
  if (!row) throw new Error("Platform AI instructions singleton missing");
  const { additionalInstructions, ...replyPacing } = row;
  return { additionalInstructions, replyPacing: ReplyPacingSchema.parse(replyPacing) };
}

export async function platformAiInstructions(db: Db) {
  const [row] = await db<PlatformAiSettingsRow[]>`
      select additional_instructions "additionalInstructions", initial_delay_seconds "initialDelaySeconds",
        active_delay_seconds "activeDelaySeconds", inactivity_reset_seconds "inactivityResetSeconds"
      from operational_controls where singleton`;
  return platformAiSettings(row);
}
export async function updatePlatformAiInstructions(db: Db, additionalInstructions: string, replyPacing?: ReplyPacing) {
  const policy = replyPacing === undefined ? undefined : ReplyPacingSchema.parse(replyPacing);
  // Omitted policy columns are not written, including under concurrent instruction-only saves.
  const values = { additional_instructions: additionalInstructions, ...(policy === undefined ? {} : {
    initial_delay_seconds: policy.initialDelaySeconds,
    active_delay_seconds: policy.activeDelaySeconds,
    inactivity_reset_seconds: policy.inactivityResetSeconds,
  }) };
  const [row] = await db<PlatformAiSettingsRow[]>`
      update operational_controls set ${db(values)} where singleton
      returning additional_instructions "additionalInstructions", initial_delay_seconds "initialDelaySeconds",
        active_delay_seconds "activeDelaySeconds", inactivity_reset_seconds "inactivityResetSeconds"`;
  return platformAiSettings(row);
}
export async function globalReplyPacing(db: Db): Promise<ReplyPacing> {
  const [row] = await db<ReplyPacing[]>`
      select initial_delay_seconds "initialDelaySeconds", active_delay_seconds "activeDelaySeconds",
        inactivity_reset_seconds "inactivityResetSeconds" from operational_controls where singleton`;
  if (!row) throw new Error("Global reply pacing singleton missing");
  return ReplyPacingSchema.parse(row);
}
export function saveAssistant(db: Db, businessId: string, active: boolean) {
  return db`insert into assistant_configs (business_id,active) values (${businessId},${active}) on conflict (business_id) do update set active=excluded.active,revision=assistant_configs.revision+1,updated_at=now()`;
}
export async function assistant(db: Db) {
  return (
    (
      await db`select style,business_instructions "businessInstructions",active,revision from assistant_configs limit 1`
    )[0] ?? null
  );
}
export async function saveFullAssistant(
  db: Db,
  businessId: string,
  p: Record<string, unknown>,
  expected: number,
) {
  return (
    (
      await db`insert into assistant_configs(business_id,style,business_instructions,active,revision) values(${businessId},${p.style as string},${p.businessInstructions as string},${p.active as boolean},1) on conflict(business_id) do update set style=excluded.style,business_instructions=excluded.business_instructions,active=excluded.active,revision=assistant_configs.revision+1,updated_at=now() where assistant_configs.revision=${expected} returning style,business_instructions "businessInstructions",active,revision`
    )[0] ?? null
  );
}
