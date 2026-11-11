import { sql } from "drizzle-orm";
import { ReplyPacingSchema, type ReplyPacing } from "@agendia/domain";
import { agentConfigs, operationalControls } from "../schema.ts";
import { result, type Db } from "./shared.ts";

const pacing = { initialDelaySeconds: operationalControls.initialDelaySeconds,
  activeDelaySeconds: operationalControls.activeDelaySeconds, inactivityResetSeconds: operationalControls.inactivityResetSeconds };
const agentProjection = { style: agentConfigs.style, businessInstructions: agentConfigs.businessInstructions,
  active: agentConfigs.active, revision: agentConfigs.revision };

export async function updateResponseTiming(db: Db, responseTiming: ReplyPacing): Promise<ReplyPacing> {
  const policy = ReplyPacingSchema.parse(responseTiming);
  const [row] = await result(db.update(operationalControls).set(policy).where(sql`${operationalControls.singleton}`).returning(pacing));
  if (!row) throw new Error("Global reply pacing singleton missing");
  return ReplyPacingSchema.parse(row);
}
export async function globalReplyPacing(db: Db): Promise<ReplyPacing> {
  const [row] = await result(db.select(pacing).from(operationalControls).where(sql`${operationalControls.singleton}`));
  if (!row) throw new Error("Global reply pacing singleton missing");
  return ReplyPacingSchema.parse(row);
}
export function saveAgent(db: Db, businessId: string, active: boolean) {
  return result(db.insert(agentConfigs).values({ businessId, active }).onConflictDoUpdate({ target: agentConfigs.businessId,
    set: { active, revision: sql`${agentConfigs.revision}+1`, updatedAt: sql`now()` } }));
}
export async function agent(db: Db) {
  const [row] = await result(db.select(agentProjection).from(agentConfigs).limit(1));
  return row ?? null;
}
export async function saveFullAgent(db: Db, businessId: string, p: Record<string, unknown>, expected: number) {
  const values = { style: p.style as string, businessInstructions: p.businessInstructions as string, active: p.active as boolean };
  const [row] = await result(db.insert(agentConfigs).values({ businessId, ...values, revision: 1 }).onConflictDoUpdate({
    target: agentConfigs.businessId,
    set: { ...values, revision: sql`${agentConfigs.revision}+1`, updatedAt: sql`now()` },
    setWhere: sql`${agentConfigs.revision}=${expected}`,
  }).returning(agentProjection));
  return row ?? null;
}
