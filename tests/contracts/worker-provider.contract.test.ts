import { describe, expect, test } from "bun:test";
import type { AiProvider, AiGenerateRequest, ConversationSummarizer } from "@agendia/domain";
import { AiProviderError, DeepSeekAdapter, DeepSeekSummarizer } from "@agendia/ai-deepseek";
import { createMessagingRuntime } from "../../apps/whatsapp-manager/src/index.ts";
import { startMessageWorker } from "../../apps/message-worker/src/index.ts";
import { deepSeekFetchDouble } from "@agendia/test-support";

const request:AiGenerateRequest={business:{name:"A"},assistant:{tone:"amable"},context:{summary:"s",retrieved:[],recent:[]},message:"hola",maxOutputCharacters:100,correlationId:"c1"};

describe("worker/provider production contracts",()=>{
  test("keeps DeepSeek behind AiProvider with a deterministic fetch boundary",async()=>{
    const double=deepSeekFetchDouble({text:"respuesta"}),provider:AiProvider=new DeepSeekAdapter({apiKey:"secret",fetcher:double.fetcher});
    expect(await provider.generate(request)).toMatchObject({text:"respuesta",providerId:"deterministic"}); expect(double.calls).toHaveLength(1);
  });
  test("classifies timeout without retry or credential exposure",async()=>{
    const double=deepSeekFetchDouble({error:new Error("timeout never-log")}),provider:AiProvider=new DeepSeekAdapter({apiKey:"never-log",fetcher:double.fetcher});
    await expect(provider.generate(request)).rejects.toBeInstanceOf(AiProviderError); expect(double.calls).toHaveLength(1);
    try{await provider.generate(request);}catch(error){expect(String(error)).not.toContain("never-log");}
  });
  test("keeps structured conversation summarization behind a replaceable boundary",async()=>{
    const content={facts:["prefiere mañana"],requests:[],commitments:[],preferences:["mañana"],openItems:[]},double=deepSeekFetchDouble({text:JSON.stringify(content)});
    const summarizer:ConversationSummarizer=new DeepSeekSummarizer({apiKey:"secret",fetcher:double.fetcher});
    expect(await summarizer.summarize({prior:null,messages:[{sequence:1,role:"customer",text:"Prefiero mañana"}],correlationId:"summary:1"})).toEqual(content);
    expect(double.calls[0]).toContain("Prefiero mañana");expect(double.calls[0]).not.toContain("secret");
  });
  test("exports executable manager messaging and pg-boss worker bootstraps",()=>{
    expect(typeof createMessagingRuntime).toBe("function"); expect(typeof startMessageWorker).toBe("function");
  });
});
