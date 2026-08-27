import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ActiveAgentId } from "../shared/participants.js";
import type { RoomAgentRoster } from "../shared/roster.js";
import { RoomStore } from "./room-store.js";
import { CommandRuntime, DEFAULT_COMMAND_STAGE_1_MS, DEFAULT_COMMAND_STAGE_2_MS, sanitizeDiagnosticText, type CommandClock, type CommandExecutionResult, type CommandLaunchHooks } from "./command-runtime.js";

class FakeClock implements CommandClock {
  value = Date.parse("2026-08-27T12:00:00.000Z");
  private sequence = 0;
  private timers = new Map<number,{at:number;callback:()=>void}>();
  now(){ return this.value; }
  setTimeout(callback:()=>void,delay:number){ const id=++this.sequence; this.timers.set(id,{at:this.value+delay,callback}); return id; }
  clearTimeout(handle:unknown){ this.timers.delete(handle as number); }
  async tick(ms:number){ this.value+=ms; for (;;) { const due=[...this.timers].filter(([,timer])=>timer.at<=this.value).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0]); if(!due.length)break; for(const [id,timer] of due){this.timers.delete(id);timer.callback();} await settle(); } await settle(); }
}

const roots:string[]=[];
afterEach(async()=>Promise.all(roots.splice(0).map((root)=>rm(root,{recursive:true,force:true}))));
const roster = (permissions: "all" | "help" = "all"):RoomAgentRoster=>({schemaVersion:3,revision:1,entries:[
  {agentId:"codex-sol",conversationalName:"Sol",modelId:"gpt-5.6-sol",enabled:true,supportsProjectWrites:true,configurationRevision:1,commandPermissions:permissions==="all"?{allowAll:true,allowed:["task","pov","poll","help"]}:{allowAll:false,allowed:["help"]}},
  {agentId:"claude-sonnet",conversationalName:"Claude",modelId:"claude-sonnet-5",enabled:true,supportsProjectWrites:true,configurationRevision:1,commandPermissions:{allowAll:true,allowed:["task","pov","poll","help"]}},
]});
async function settle(){ for(let index=0;index<8;index++)await new Promise<void>((resolve)=>setImmediate(resolve)); }
async function eventually(assertion:()=>void|Promise<void>){let failure:unknown;for(let index=0;index<100;index++){try{await assertion();return;}catch(error){failure=error;await settle();}}throw failure;}
async function fixture(options:{clock?:FakeClock; roster?:()=>RoomAgentRoster; execute?:(agent:ActiveAgentId,prompt:string,hooks:CommandLaunchHooks)=>Promise<CommandExecutionResult>; deliver?:(attemptId:string,agent:ActiveAgentId,messages:readonly string[],result:CommandExecutionResult)=>Promise<void>; povExecute?:(agents:readonly ActiveAgentId[],prompt:string,signal:AbortSignal)=>Promise<void>; publish?:(id:string,text:string)=>Promise<void>; eligible?:(agent:ActiveAgentId)=>boolean;capacityOne?:boolean}={}){
  const root=await mkdtemp(path.join(os.tmpdir(),"amfaa-command-runtime-"));roots.push(root);const store=await RoomStore.open(root,path.join(root,"state"));const clock=options.clock||new FakeClock();const statuses:string[]=[];const deliveries:Array<{agent:ActiveAgentId;messages:readonly string[]}>=[];const pov:ActiveAgentId[][]=[];
  let reserved=false;const published=new Set<string>();const runtime=new CommandRuntime({store,clock,stage1Ms:10,stage2Ms:20,roster:options.roster||(()=>roster()),canLaunch:options.eligible||(()=>!reserved),...(options.capacityOne?{reserveLaunch:()=>{if(reserved)return undefined;reserved=true;return{release(){reserved=false;}};}}:{}),executeTask:options.execute|| (async(agent,_prompt,hooks)=>{await hooks.active(`generation-${agent}`);return{generationId:`generation-${agent}`,visibleMessages:[`reply-${agent}`]};}),executePov:options.povExecute|| (async(agents)=>{pov.push([...agents]);}),publishStatus:options.publish|| (async(id,text)=>{if(!published.has(id)){published.add(id);statuses.push(text);}}),deliverTask:options.deliver|| (async(_attemptId,agent,messages)=>{deliveries.push({agent,messages});})});
  return{runtime,store,clock,statuses,deliveries,pov};
}

describe("durable command runtime",()=>{
  it("keeps production watchdog defaults inside the required safety windows",()=>{expect(DEFAULT_COMMAND_STAGE_1_MS).toBeGreaterThanOrEqual(10_000);expect(DEFAULT_COMMAND_STAGE_1_MS).toBeLessThanOrEqual(15_000);expect(DEFAULT_COMMAND_STAGE_2_MS).toBeGreaterThanOrEqual(60_000);expect(DEFAULT_COMMAND_STAGE_2_MS).toBeLessThanOrEqual(90_000);});
  it("redacts structured JSON, env assignments, headers, and complete bearer/basic credentials",()=>{
    const raw='{"password":"json-secret","authorization":"Bearer json-token"}\nAPI_KEY=env-secret\nAuthorization: Basic YWxhZGRpbjpvcGVuc2VzYW1l\nCookie: session=cookie-one; refresh=cookie-two\nSet-Cookie: sid=set-one; HttpOnly\nloose Bearer loose-token and Basic dXNlcjpwYXNz';
    const redacted=sanitizeDiagnosticText(raw)!;
    for(const secret of ["json-secret","json-token","env-secret","YWxhZGRpbjpvcGVuc2VzYW1l","cookie-one","cookie-two","set-one","loose-token","dXNlcjpwYXNz"])expect(redacted).not.toContain(secret);
    expect(redacted).toContain("[REDACTED");
  });
  it("routes human text and structured agent tools through identical parsing, authorization, audit, and dispatch",async()=>{
    const human=await fixture();
    expect(await human.runtime.submit("/task ship it",{kind:"human",id:"h1",displayName:"Ada"},"human-cmd-0001")).toMatchObject({kind:"accepted",duplicate:false});
    await eventually(()=>expect(human.deliveries).toEqual([{agent:"codex-sol",messages:["reply-codex-sol"]}]));
    expect(human.statuses).toEqual(["— Ada ran /task — Target: Sol"]);
    const tool=await fixture();
    expect(await tool.runtime.submit({command:"task",prompt:"ship it",selection:{kind:"round-robin"}},{kind:"agent",id:"codex-sol",displayName:"Sol"},"agent-cmd-0001")).toMatchObject({kind:"accepted",duplicate:false});
    await eventually(()=>expect(tool.deliveries).toEqual([{agent:"codex-sol",messages:["reply-codex-sol"]}]));
    const denied=await fixture({roster:()=>roster("help")});
    expect(await denied.runtime.submit({command:"task",prompt:"no",selection:{kind:"round-robin"}},{kind:"agent",id:"codex-sol",displayName:"Sol"},"agent-cmd-0002")).toMatchObject({kind:"private-error"});
    expect(await denied.runtime.submit("/help",{kind:"agent",id:"codex-sol",displayName:"Sol"},"agent-cmd-0003")).toEqual({kind:"private-help",commands:["help"]});
    expect(denied.statuses).toEqual([]);
  });

  it("fails closed when agent command permission changes before atomic acceptance",async()=>{let current=roster();let checked=false;const api=await fixture({roster:()=>current,eligible:()=>{if(!checked){checked=true;current=roster("help");}return true;}});expect(await api.runtime.submit({command:"task",prompt:"no",selection:{kind:"round-robin"}},{kind:"agent",id:"codex-sol",displayName:"Sol"},"permission-race-1")).toEqual({kind:"private-error",message:"Command permission changed before dispatch."});expect(api.statuses).toEqual([]);expect(api.deliveries).toEqual([]);});

  it("uses command permissions only for tool invokers, never for human-selected targets",async()=>{const api=await fixture({roster:()=>roster("help")});expect(await api.runtime.submit("/task human work",{kind:"human",id:"h1",displayName:"Ada"},"human-target-01")).toMatchObject({kind:"accepted"});await eventually(()=>expect(api.deliveries[0]?.agent).toBe("codex-sol"));expect(await api.runtime.submit("/pov human views",{kind:"human",id:"h1",displayName:"Ada"},"human-target-02")).toMatchObject({kind:"accepted"});await eventually(()=>expect(api.pov).toEqual([["codex-sol","claude-sonnet"]]));expect(await api.runtime.submit({command:"task",prompt:"agent work",selection:{kind:"round-robin"}},{kind:"agent",id:"codex-sol",displayName:"Sol"},"agent-target-01")).toMatchObject({kind:"private-error"});});

  it("keeps pov bounded to launch-eligible participants and polls durable, ordered, authoritative, and replay-safe",async()=>{
    const api=await fixture({eligible:(agent)=>agent==="codex-sol"});
    expect(await api.runtime.submit("/pov thoughts?",{kind:"human",id:"h1",displayName:"Ada"},"human-pov-0001")).toMatchObject({kind:"accepted"});await eventually(()=>expect(api.pov).toEqual([["codex-sol"]]));
    const first=await api.runtime.submit('/poll "Choose" "B" "A"',{kind:"human",id:"h1",displayName:"Ada"},"human-poll-001");
    expect(first).toMatchObject({kind:"accepted",duplicate:false,poll:{options:["B","A"],tallies:[0,0]}});
    const pollId=(first as Extract<typeof first,{kind:"accepted"}>).poll!.pollId;
    expect(await api.runtime.vote(pollId,"human-1","vote-invalid-negative",-1)).toMatchObject({kind:"private-error"});
    expect(await api.runtime.vote(pollId,"human-1","vote-invalid-fraction",0.5)).toMatchObject({kind:"private-error"});
    expect(await api.runtime.vote(pollId,"h1","vote-recovery-01",1)).toMatchObject({kind:"accepted",duplicate:false,poll:{tallies:[0,1]}});
    expect(await api.runtime.vote(pollId,"replacement-human","vote-recovery-01",0)).toMatchObject({kind:"accepted",duplicate:true,poll:{tallies:[0,1]}});
    expect(await api.runtime.submit('/poll "Choose" "B" "A"',{kind:"human",id:"h1",displayName:"Ada"},"human-poll-001")).toMatchObject({kind:"accepted",duplicate:true,poll:{tallies:[0,1]}});
    expect(api.statuses.filter((line)=>line.includes("/poll"))).toHaveLength(1);
  });

  it("persists POV ownership before acknowledgement and records rejection, replay, shutdown, and late completion exactly once",async()=>{let calls=0;const rejected=await fixture({povExecute:async()=>{calls++;throw new Error("enqueue rejected");}});const first=await rejected.runtime.submit("/pov discuss",{kind:"human",id:"h1",displayName:"Ada"},"pov-reject-01");expect(first).toMatchObject({kind:"accepted",duplicate:false});await eventually(async()=>expect((await rejected.store.getPovExecution("00000000-0000-4000-8000-000000000001",(first as Extract<typeof first,{kind:"accepted"}>).submissionId))?.status).toBe("failed"));expect(await rejected.runtime.submit("/pov discuss",{kind:"human",id:"h1",displayName:"Ada"},"pov-reject-01")).toMatchObject({kind:"accepted",duplicate:true});expect(calls).toBe(1);
    let finish!:()=>void;const pending=new Promise<void>((resolve)=>{finish=resolve;});const cancelled=await fixture({povExecute:async()=>pending});const value=await cancelled.runtime.submit("/pov wait",{kind:"human",id:"h1",displayName:"Ada"},"pov-cancel-01");await cancelled.runtime.close();finish();await settle();expect((await cancelled.store.getPovExecution("00000000-0000-4000-8000-000000000001",(value as Extract<typeof value,{kind:"accepted"}>).submissionId))?.status).toBe("cancelled");
  });

  it("acknowledges durable task and POV work even when audit publication fails",async()=>{let taskRuns=0;const task=await fixture({publish:async()=>{throw new Error("audit unavailable");},execute:async(agent,_prompt,hooks)=>{taskRuns++;await hooks.active("audit-task");return{generationId:"audit-task",visibleMessages:[agent]};}});expect(await task.runtime.submit("/task keep going",{kind:"human",id:"h1",displayName:"Ada"},"audit-failure-task-01")).toMatchObject({kind:"accepted",duplicate:false});await eventually(()=>expect(task.deliveries).toHaveLength(1));expect(await task.runtime.submit("/task keep going",{kind:"human",id:"h1",displayName:"Ada"},"audit-failure-task-01")).toMatchObject({kind:"accepted",duplicate:true});expect(taskRuns).toBe(1);
    let povRuns=0;const pov=await fixture({publish:async()=>{throw new Error("audit unavailable");},povExecute:async()=>{povRuns++;}});expect(await pov.runtime.submit("/pov keep going",{kind:"human",id:"h1",displayName:"Ada"},"audit-failure-pov-01")).toMatchObject({kind:"accepted",duplicate:false});await eventually(()=>expect(povRuns).toBe(1));});

  it("persists provider state for silent command completions",async()=>{const delivered:Array<{messages:readonly string[];result:CommandExecutionResult}>=[];const api=await fixture({execute:async(_agent,_prompt,hooks)=>{await hooks.active("silent-generation");return{generationId:"silent-generation",visibleMessages:[],sessionId:"session-silent",permission:"read-only",cursorMessageId:"message-42"};},deliver:async(_attempt,_agent,messages,result)=>{delivered.push({messages,result});}});await api.runtime.submit("/task inspect quietly",{kind:"human",id:"h1",displayName:"Ada"},"silent-session-task-01");await eventually(()=>expect(delivered).toEqual([{messages:[],result:expect.objectContaining({sessionId:"session-silent",cursorMessageId:"message-42"})}]));});

  it("atomically hands reserved capacity to the active generation and suppresses stale epoch output",async()=>{let resolveFirst!:(value:CommandExecutionResult)=>void;const first=new Promise<CommandExecutionResult>((resolve)=>{resolveFirst=resolve;});let revision=1;let calls=0;let active=false;const api=await fixture({capacityOne:true,eligible:()=>!active,roster:()=>({...roster(),revision}),execute:async(agent,_prompt,hooks)=>{calls++;active=true;try{await hooks.active(`g-${calls}`);if(calls===1)return await first;return{generationId:`g-${calls}`,visibleMessages:[`fresh-${agent}`]};}finally{active=false;}}});const accepted=await api.runtime.submit("/task first",{kind:"human",id:"h1",displayName:"Ada"},"capacity-one-01");expect(await api.runtime.submit("/task second",{kind:"human",id:"h1",displayName:"Ada"},"capacity-one-02")).toMatchObject({kind:"private-error"});revision=2;resolveFirst({generationId:"g-1",visibleMessages:["stale"]});await eventually(()=>expect(api.deliveries).toEqual([{agent:"claude-sonnet",messages:["fresh-claude-sonnet"]}]));const attempts=await api.store.listCommandAttempts("00000000-0000-4000-8000-000000000001",(accepted as Extract<typeof accepted,{kind:"accepted"}>).submissionId);expect(attempts.map((item)=>item.status)).toEqual(["superseded","completed"]);expect(attempts.every((item)=>item.rosterRevision!==undefined&&item.roomEpoch!==undefined)).toBe(true);});

  it("atomically reassigns stage-one stalls and ignores a late completion",async()=>{
    const clock=new FakeClock();let firstHooks:CommandLaunchHooks|undefined;let finishFirst!:(value:CommandExecutionResult)=>void;const first=new Promise<CommandExecutionResult>((resolve)=>{finishFirst=resolve;});
    const api=await fixture({clock,execute:async(agent,_prompt,hooks)=>{if(agent==="codex-sol"){firstHooks=hooks;return first;}await hooks.active("generation-2");return{generationId:"generation-2",visibleMessages:["fallback"]};}});
    const accepted=await api.runtime.submit("/task work",{kind:"human",id:"h1",displayName:"Ada"},"watchdog-one-01");await clock.tick(10);
    await eventually(()=>expect(firstHooks!.signal.aborted).toBe(true));await eventually(()=>expect(api.deliveries).toEqual([{agent:"claude-sonnet",messages:["fallback"]}]));expect(api.statuses.filter((line)=>line.includes("reassigned"))).toHaveLength(1);
    finishFirst({generationId:"late",visibleMessages:["late"]});await settle();expect(api.deliveries).toHaveLength(1);
    const attempts=await api.store.listCommandAttempts("00000000-0000-4000-8000-000000000001",(accepted as Extract<typeof accepted,{kind:"accepted"}>).submissionId);
    expect(attempts.map(({status})=>status)).toEqual(["superseded","completed"]);
  });

  it("wins stage-two terminal races exactly once and stores one bounded sanitized partial",async()=>{
    const clock=new FakeClock();let resolveFirst!:(value:CommandExecutionResult)=>void;const first=new Promise<CommandExecutionResult>((resolve)=>{resolveFirst=resolve;});let calls=0;let activeReady=false;let firstSignal:AbortSignal|undefined;
    const api=await fixture({clock,execute:async(agent,_prompt,hooks)=>{calls++;await hooks.active(`generation-${calls}`);activeReady=true;if(calls===1){firstSignal=hooks.signal;hooks.partial("Authorization: bearer-secret\nuseful partial");return first;}return{generationId:"generation-2",visibleMessages:["replacement"]};}});
    const accepted=await api.runtime.submit("/task work",{kind:"human",id:"h1",displayName:"Ada"},"watchdog-two-01");await eventually(()=>expect(activeReady).toBe(true));await clock.tick(20);await eventually(()=>expect(firstSignal?.aborted).toBe(true));
    resolveFirst({generationId:"generation-1",visibleMessages:["late"]});await eventually(()=>expect(api.deliveries).toEqual([{agent:"claude-sonnet",messages:["replacement"]}]));
    const diagnostics=await api.store.listDiagnostics("00000000-0000-4000-8000-000000000001",{agentId:"codex-sol",search:"useful"});expect(diagnostics).toHaveLength(1);expect(diagnostics[0]!.diagnosticText).not.toContain("bearer-secret");expect(JSON.stringify(api.store.snapshot())).not.toContain("useful partial");
    const attempts=await api.store.listCommandAttempts("00000000-0000-4000-8000-000000000001",(accepted as Extract<typeof accepted,{kind:"accepted"}>).submissionId);expect(attempts.map(({status})=>status)).toEqual(["superseded","completed"]);
  });

  it("recovers persisted pending ownership after restart without duplicate reassignment",async()=>{
    const clock=new FakeClock();const api=await fixture({clock,execute:async()=>new Promise(()=>undefined)});const accepted=await api.runtime.submit("/task recover",{kind:"human",id:"h1",displayName:"Ada"},"restart-watch-01");await api.runtime.close();
    const restarted=new CommandRuntime({store:api.store,clock,stage1Ms:10,stage2Ms:20,roster:()=>roster(),canLaunch:()=>true,executeTask:async(agent,_prompt,hooks)=>{await hooks.active("recovered");return{generationId:"recovered",visibleMessages:[agent]};},executePov:async()=>undefined,publishStatus:async(_id,text)=>{if(!api.statuses.includes(text))api.statuses.push(text);},deliverTask:async(_attemptId,agent,messages)=>{api.deliveries.push({agent,messages});}});await restarted.initialize();await clock.tick(10);
    await eventually(()=>expect(api.deliveries).toEqual([{agent:"claude-sonnet",messages:["claude-sonnet"]}]));expect(api.statuses.filter((line)=>line.includes("reassigned"))).toHaveLength(1);const attempts=await api.store.listCommandAttempts("00000000-0000-4000-8000-000000000001",(accepted as Extract<typeof accepted,{kind:"accepted"}>).submissionId);expect(attempts).toHaveLength(2);
  });

  it("recovers a durable delivery outbox with provider state without rerunning the provider",async()=>{let executions=0;const api=await fixture({execute:async(agent,_prompt,hooks)=>{executions++;await hooks.active("delivery-generation");return{generationId:"delivery-generation",visibleMessages:[`durable-${agent}`],sessionId:"durable-session",permission:"writable",codeEpoch:"epoch-1",cursorMessageId:"message-9"};},deliver:async()=>{throw new Error("storage unavailable");}});const accepted=await api.runtime.submit("/task durable",{kind:"human",id:"h1",displayName:"Ada"},"delivery-recovery-01");const submissionId=(accepted as Extract<typeof accepted,{kind:"accepted"}>).submissionId;await eventually(async()=>expect((await api.store.listCommandAttempts("00000000-0000-4000-8000-000000000001",submissionId))[0]).toMatchObject({status:"delivery-pending",deliveryResult:{sessionId:"durable-session",permission:"writable",codeEpoch:"epoch-1",cursorMessageId:"message-9"}}));await api.runtime.close();const delivered:Array<{messages:string[];result:CommandExecutionResult}>=[];const restarted=new CommandRuntime({store:api.store,clock:api.clock,roster:()=>roster(),canLaunch:()=>true,executeTask:async()=>{executions++;throw new Error("must not rerun");},executePov:async()=>undefined,publishStatus:async()=>undefined,deliverTask:async(_id,_agent,messages,result)=>{delivered.push({messages:[...messages],result});}});await restarted.initialize();expect(executions).toBe(1);expect(delivered).toEqual([{messages:["durable-codex-sol"],result:expect.objectContaining({sessionId:"durable-session",permission:"writable",codeEpoch:"epoch-1",cursorMessageId:"message-9"})}]);expect((await api.store.listCommandAttempts("00000000-0000-4000-8000-000000000001",submissionId))[0]?.status).toBe("completed");});

  it("claims silent delivery ownership before provider-state projection",async()=>{let executions=0;const api=await fixture({execute:async(_agent,_prompt,hooks)=>{executions++;await hooks.active("silent-crash");return{generationId:"silent-crash",visibleMessages:[],sessionId:"silent-session",permission:"read-only"};},deliver:async()=>{throw new Error("projection unavailable");}});const accepted=await api.runtime.submit("/task silent",{kind:"human",id:"h1",displayName:"Ada"},"silent-outbox-task-01");const submissionId=(accepted as Extract<typeof accepted,{kind:"accepted"}>).submissionId;await eventually(async()=>expect((await api.store.listCommandAttempts("00000000-0000-4000-8000-000000000001",submissionId))[0]).toMatchObject({status:"delivery-pending",deliveryMessages:[],deliveryResult:{sessionId:"silent-session"}}));await api.runtime.close();const delivered:CommandExecutionResult[]=[];const restarted=new CommandRuntime({store:api.store,clock:api.clock,roster:()=>roster(),canLaunch:()=>true,executeTask:async()=>{executions++;throw new Error("must not rerun");},executePov:async()=>undefined,publishStatus:async()=>undefined,deliverTask:async(_id,_agent,messages,result)=>{expect(messages).toEqual([]);delivered.push(result);}});await restarted.initialize();expect(executions).toBe(1);expect(delivered).toEqual([expect.objectContaining({sessionId:"silent-session",permission:"read-only"})]);});
  it("bounds provider output before persisting the delivery outbox",async()=>{const api=await fixture({execute:async(agent,_prompt,hooks)=>{await hooks.active("oversized-generation");return{generationId:"oversized-generation",visibleMessages:["x".repeat(5_000),`ok-${agent}`]};}});await api.runtime.submit("/task bounded",{kind:"human",id:"h1",displayName:"Ada"},"delivery-bounds-01");await eventually(()=>expect(api.deliveries).toHaveLength(1));expect(api.deliveries[0]!.messages[0]).toHaveLength(4_000);});
});
