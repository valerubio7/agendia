import { randomUUID } from "node:crypto";
import type { createRuntimePools } from "@agendia/db";

type Pools=ReturnType<typeof createRuntimePools>;
export interface JobPublisher{send(name:string,data?:object|null,options?:object):Promise<string|null>}
export interface AiOutboxOptions{queueName?:string;batchSize?:number;claimTtlMs?:number;retryBaseMs?:number}

export class AiOutboxDispatcher{
  private readonly queueName:string;private readonly batchSize:number;private readonly claimTtlMs:number;private readonly retryBaseMs:number;
  constructor(private pools:Pools,private publisher:JobPublisher,options:AiOutboxOptions={}){
    this.queueName=options.queueName??"ai-generate";this.batchSize=options.batchSize??20;this.claimTtlMs=options.claimTtlMs??30_000;this.retryBaseMs=options.retryBaseMs??1_000;
  }
  async dispatchBatch():Promise<number>{
    const token=randomUUID(),rows=await this.pools.manager.run(undefined,r=>r.claimAiOutbox(token,this.batchSize,this.claimTtlMs));let published=0;
    for(const row of rows){
      try{
        const data={...(row.payload as object),correlationId:row.stable_key};
        await this.publisher.send(this.queueName,data,{id:row.id,singletonKey:row.stable_key,retryLimit:0});
        published+=await this.pools.manager.run(undefined,r=>r.completeAiOutbox(row.id,token));
      }catch{
        const delay=Math.min(60_000,this.retryBaseMs*2**Math.min(row.publish_attempts-1,6));
        await this.pools.manager.run(undefined,r=>r.releaseAiOutbox(row.id,token,delay));
      }
    }
    return published;
  }
}
