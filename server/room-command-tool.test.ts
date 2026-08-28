import express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { CommandRuntime } from "./command-runtime.js";
import { RoomStore } from "./room-store.js";
import { registerRoomCommandToolRoute, RoomCommandToolBroker, type CommandToolLeaseEvent } from "./room-command-tool.js";

const roots:string[]=[];afterEach(async()=>Promise.all(roots.splice(0).map((root)=>rm(root,{recursive:true,force:true}))));

async function fixture() {
  const root=await mkdtemp(path.join(os.tmpdir(),"amfaa-room-command-tool-"));roots.push(root);const store=await RoomStore.open(root,path.join(root,"state"));
  const current=store.snapshot().roster!.entries.map((entry)=>entry.agentId==="codex-sol"?{...entry,commandPermissions:{allowAll:false,allowed:["help" as const,"poll" as const]}}:entry);await store.updateRoster(1,current);
  const runtime=new CommandRuntime({store,roster:()=>store.snapshot().roster!,canLaunch:()=>true,executeTask:async()=>({}),executePov:async()=>({}),deliverPov:async()=>undefined,publishStatus:async()=>undefined,deliverTask:async()=>undefined});
  const broker=new RoomCommandToolBroker(runtime);const token=broker.issue({agentId:"codex-sol",displayName:"Sol",providerSessionId:"session-bound",allowedCommands:["help","poll"]});return{store,runtime,broker,token};
}

describe("server-owned room_command broker",()=>{
  it("projects safe command-family lease audit without duplicate or argument records",async()=>{
    const api=await fixture();let now=Date.parse("2026-08-27T00:00:00.000Z");let session:string|null="session-a";const observed:CommandToolLeaseEvent[]=[];
    const broker=new RoomCommandToolBroker(api.runtime,()=>now,()=>session,(event)=>observed.push(event));
    const token=broker.issue({agentId:"codex-sol",displayName:"Sol",providerSessionId:"session-a",allowedCommands:["help"]});
    expect(observed[0]).toMatchObject({outcome:"issued",reason:"lease-issued",command:null,selectorFamily:null});
    expect(broker.snapshot("codex-sol")).toMatchObject({present:true,status:"active",providerSessionFresh:true,effectiveCommands:["help"],lastManifestIssuance:{revision:1}});
    expect(JSON.stringify(broker.snapshot("codex-sol"))).not.toContain("session-a");expect(JSON.stringify(broker.snapshot("codex-sol"))).not.toContain(token);
    const request={invocation:{command:"help" as const},clientSubmissionId:"lease-help-request-01"};await broker.execute(token,request);await broker.execute(token,request);
    expect(observed.filter(({outcome,reason})=>outcome==="accepted"&&reason==="tool-call-accepted")).toHaveLength(1);
    expect(observed.find(({outcome})=>outcome==="accepted")).toMatchObject({command:"help",selectorFamily:null});
    await broker.execute(token,{invocation:{command:"polls"},clientSubmissionId:"lease-polls-denied-01"});await broker.execute(token,{invocation:{command:"polls"},clientSubmissionId:"lease-polls-denied-01"});
    expect(observed.filter(({outcome,reason})=>outcome==="rejected"&&reason==="permission-not-granted")).toHaveLength(1);
    expect(observed.find(({outcome})=>outcome==="rejected")).toMatchObject({command:"poll",selectorFamily:null});
    const ghToken=broker.issue({agentId:"codex-sol",displayName:"Sol",providerSessionId:"session-a",allowedCommands:["gh"]});
    await broker.execute(ghToken,{invocation:{command:"gh",selector:{kind:"pr",number:987654}},clientSubmissionId:"lease-gh-request-01"});
    await broker.execute(ghToken,{invocation:{command:"gh",selector:{kind:"recent"}},clientSubmissionId:"lease-gh-request-02"});
    await broker.execute(ghToken,{invocation:{command:"gh",selector:{kind:"issue",number:456789}},clientSubmissionId:"lease-gh-request-03"});
    await broker.execute(ghToken,{invocation:{command:"gh",selector:{kind:"ci",number:345678}},clientSubmissionId:"lease-gh-request-04"});
    expect(observed.filter(({command})=>command==="gh").map(({selectorFamily})=>selectorFamily)).toEqual(["pr","recent","issue","ci"]);
    expect(JSON.stringify(observed)).not.toContain("987654");
    expect(JSON.stringify(observed)).not.toContain("456789");
    expect(JSON.stringify(observed)).not.toContain("345678");
    const refreshed=broker.issue({agentId:"codex-sol",displayName:"Sol",providerSessionId:"session-a",allowedCommands:["help"]});expect(observed.some(({outcome})=>outcome==="refreshed")).toBe(true);
    session="session-b";expect(broker.snapshot("codex-sol")).toMatchObject({present:false,status:"revoked",providerSessionFresh:false,effectiveCommands:[]});expect(await broker.execute(refreshed,request)).toBeUndefined();
    expect(observed.filter(({outcome,reason})=>outcome==="revoked"&&reason==="provider-session-stale")).toHaveLength(1);
    broker.issue({agentId:"codex-sol",displayName:"Sol",providerSessionId:"session-b",allowedCommands:["help"]});now+=10*60_000;expect(broker.snapshot("codex-sol")).toMatchObject({present:false,status:"expired",effectiveCommands:[]});
    expect(observed.filter(({outcome,reason})=>outcome==="expired"&&reason==="lease-expired")).toHaveLength(1);
    expect(observed.filter(({outcome})=>outcome==="rejected").every(({reason})=>["invalid-request-id","request-id-substitution","bounded-call-limit","permission-not-granted"].includes(reason))).toBe(true);
    expect(broker.audit()).toEqual(observed);
  });

  it("binds identity and request IDs, supports only exact transport replay, and rechecks revocation",async()=>{const api=await fixture();const input={invocation:{command:"help" as const},clientSubmissionId:"agent-tool-help-01"};const first=await api.broker.execute(api.token,input);expect(first).toMatchObject({kind:"private-help",commands:["poll","help"],duplicate:false});expect(await api.broker.execute(api.token,input)).toEqual(first);expect(await api.broker.execute(api.token,{invocation:{command:"poll",question:"Substituted",options:["A","B"]},clientSubmissionId:"agent-tool-help-01"})).toEqual({kind:"private-error",message:"That request ID is already bound to a different room command."});expect(await api.broker.execute(api.token,{invocation:{command:"poll",question:"Different",options:["A","B"]},clientSubmissionId:"agent-tool-poll-01"})).toMatchObject({kind:"accepted",duplicate:false});expect(await api.broker.execute(api.token,{invocation:{command:"polls"},clientSubmissionId:"short"})).toEqual({kind:"private-error",message:"A valid command request ID is required."});
    const next=api.store.snapshot().roster!.entries.map((entry)=>entry.agentId==="codex-sol"?{...entry,commandPermissions:{allowAll:false,allowed:["help" as const]}}:entry);await api.store.updateRoster(2,next);const revokedToken=api.broker.issue({agentId:"codex-sol",displayName:"Sol",providerSessionId:"session-bound",allowedCommands:["help","poll"]});expect(await api.broker.execute(revokedToken,{invocation:{command:"poll",question:"No",options:["A","B"]},clientSubmissionId:"agent-tool-poll-02"})).toEqual({kind:"private-error",message:"That command is not available to this participant."});
  });

  it("exposes only the opaque broker route and never accepts caller-selected identity",async()=>{const api=await fixture();const app=express();app.use(express.json());registerRoomCommandToolRoute(app,api.broker);const server=app.listen(0,"127.0.0.1");await new Promise<void>((resolve)=>server.once("listening",resolve));const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;try{expect((await fetch(`${base}/api/agent-tools/room-command`,{method:"POST",headers:{"content-type":"application/json"},body:"{}"})).status).toBe(404);const response=await fetch(`${base}/api/agent-tools/room-command`,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${api.token}`},body:JSON.stringify({clientSubmissionId:"agent-route-help-01",invocation:{command:"help"},agentId:"claude-sonnet",roomId:"forged",permission:"all"})});expect(response.status).toBe(200);expect(await response.json()).toMatchObject({kind:"private-help",commands:["poll","help"]});const submissions=await api.store.listCommandAuditIdentities("00000000-0000-4000-8000-000000000001");expect(submissions).toEqual([expect.objectContaining({invokerKind:"agent",invokerId:"codex-sol"})]);}finally{await new Promise<void>((resolve,reject)=>server.close((error)=>error?reject(error):resolve()));}
  });

  it("uses the bound agent identity for poll discovery, voting, and creator closure",async()=>{const api=await fixture();const created=await api.broker.execute(api.token,{invocation:{command:"poll",question:"Choose",options:["A","B"]},clientSubmissionId:"agent-tool-create-poll-01"}) as {poll:{pollId:string}};const pollId=created.poll.pollId;expect(await api.broker.execute(api.token,{invocation:{command:"polls"},clientSubmissionId:"agent-tool-list-polls-01"})).toMatchObject({kind:"polls",items:[{pollId,state:"OPEN"}]});expect(await api.broker.execute(api.token,{invocation:{command:"poll_vote",pollId,optionIndex:1},clientSubmissionId:"agent-tool-vote-poll-01"})).toMatchObject({kind:"accepted",poll:{ownVote:1,tallies:[0,1]}});expect(await api.broker.execute(api.token,{invocation:{command:"poll_close",pollId,expectedRevision:1},clientSubmissionId:"agent-tool-close-poll-01"})).toMatchObject({kind:"accepted",poll:{state:"CLOSED",tallies:[0,1]}});expect(await api.broker.execute(api.token,{invocation:{command:"polls"},clientSubmissionId:"agent-tool-list-polls-02"})).toMatchObject({kind:"polls",items:[]});});
  it("revokes obsolete provider-session leases before runtime or cached command data is reachable",async()=>{const api=await fixture();let session:string|null="session-a";const broker=new RoomCommandToolBroker(api.runtime,Date.now,()=>session);const token=broker.issue({agentId:"codex-sol",displayName:"Sol",providerSessionId:"session-a",allowedCommands:["help"]});session="session-b";expect(await broker.execute(token,{invocation:{command:"help"},clientSubmissionId:"stale-session-help-01"})).toBeUndefined();expect(await api.store.listCommandAuditIdentities("00000000-0000-4000-8000-000000000001")).toEqual([]);});
  it("keeps synchronous and rejected operation logging outside lease state",async()=>{const api=await fixture();let calls=0;const broker=new RoomCommandToolBroker(api.runtime,Date.now,undefined,()=>{calls++;if(calls===1)throw new Error("sync logger");return Promise.reject(new Error("async logger"));});const token=broker.issue({agentId:"codex-sol",displayName:"Sol",providerSessionId:null,allowedCommands:["help"]});expect(broker.snapshot("codex-sol")).toMatchObject({present:true,status:"active",effectiveCommands:["help"]});expect(await broker.execute(token,{invocation:{command:"help"},clientSubmissionId:"logging-boundary-01"})).toMatchObject({kind:"private-help"});await new Promise((resolve)=>setTimeout(resolve,0));expect(broker.audit().map(({outcome})=>outcome)).toEqual(["issued","accepted"]);});
});
