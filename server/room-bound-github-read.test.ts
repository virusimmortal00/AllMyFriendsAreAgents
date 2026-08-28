import { describe, expect, it, vi } from "vitest";
import { GitHubReadFailure, type GitHubReadFetch } from "./github-read-adapter.js";
import { type ProjectRepositoryConnection, ServerHeldRepositoryCredentials } from "./project-repository-connection.js";
import { RoomBoundGitHubReadService } from "./room-bound-github-read.js";

const sha = "0123456789abcdef0123456789abcdef01234567";
const secretOne = "github_pat_room_bound_secret_one";
const secretTwo = "github_pat_room_bound_secret_two";

function connection(projectId:string,connectionId:string,owner:string,repository:string,credentialReference:string):ProjectRepositoryConnection{return{
  schemaVersion:1,connectionId,projectId,revision:1,state:"verified",remote:{provider:"github",owner,repository,canonical:`github.com/${owner}/${repository}`},
  checkoutMode:"existing-local",checkoutPath:`/repos/${projectId}`,commonDirectory:`/repos/${projectId}/.git`,defaultBranch:"main",protectedBranches:["main"],
  policyRevision:1,worktreeRoot:`/worktrees/${projectId}`,validationCommands:[],sensitivePaths:[],credentialReference,identityDigest:"a".repeat(64),
  validatedAt:"2026-08-28T00:00:00.000Z",disabledAt:null,createdAt:"2026-08-28T00:00:00.000Z",updatedAt:"2026-08-28T00:00:00.000Z",
};}

function fixture(options:{maxEntries?:number}={}){
  const rooms=new Map<string,string|null>([["room-a","project-one"],["room-b","project-one"],["room-c","project-two"],["room-general",null],["room-missing-project","project-missing"],["room-unverified","project-unverified"],["room-stale","project-stale"]]);
  const records=new Map<string,ProjectRepositoryConnection>([["project-one",connection("project-one","connection-one","owner","one","credential-one")],["project-two",connection("project-two","connection-two","owner","two","credential-two")]]);
  const credentials=new ServerHeldRepositoryCredentials();credentials.register("project-one","credential-one",secretOne);credentials.register("project-two","credential-two",secretTwo);
  const identities={
    async getStorageScope(roomId:string){if(!rooms.has(roomId))return undefined;const projectId=rooms.get(roomId)!;return{schemaVersion:1 as const,serverId:"server-one",roomId,projectId,repositoryReferenceId:null,repositoryReferenceRevision:null};},
    async getDurableProject(projectId:string){if(![...rooms.values()].includes(projectId)||projectId==="project-missing")return undefined;return{schemaVersion:1 as const,projectId,serverId:"server-one",revision:1,name:projectId,repositoryCapacity:1 as const,repositoryReferenceId:projectId==="project-unverified"?"legacy-ref":projectId==="project-stale"?"stale-ref":null,createdAt:"2026-08-28T00:00:00.000Z",updatedAt:"2026-08-28T00:00:00.000Z"};},
    async getRepositoryReference(repositoryReferenceId:string){return repositoryReferenceId==="legacy-ref"?{schemaVersion:1 as const,repositoryReferenceId,projectId:"project-unverified",revision:1,state:"unverified-legacy-placeholder" as const,localPath:"/legacy",sanitizedRemoteIdentity:"github.com/owner/legacy",createdAt:"2026-08-28T00:00:00.000Z",updatedAt:"2026-08-28T00:00:00.000Z"}:undefined;},
  };
  const fetcher:GitHubReadFetch=vi.fn(async(input)=>response(new URL(input)));
  const service=new RoomBoundGitHubReadService(identities,(projectId)=>({
    inspectServer:()=>records.get(projectId),
    revalidateAuthority:async(expectedRevision:number)=>{const current=records.get(projectId);return current?.state==="verified"&&current.revision===expectedRevision?{kind:"ok" as const,connection:structuredClone(current)}:{kind:"rejected" as const,reason:current?.revision!==expectedRevision?"Repository connection revision is stale.":"Repository identity drift."};},
  }) as never,credentials,{fetcher,...options});
  return{service,fetcher,records,rooms};
}

describe("room-bound read-only GitHub resolution",()=>{
  it("shares sanitized entries only for independently authorized rooms on one immutable verified scope",async()=>{
    const f=fixture();
    await expect(f.service.execute("room-a",{kind:"pr",number:7})).resolves.toMatchObject({projection:{kind:"pr",repository:"owner/one",pull:{number:7}}});
    await expect(f.service.execute("room-b",{kind:"pr",number:7})).resolves.toMatchObject({diagnostics:[{cacheOutcome:"hit"}]});
    await expect(f.service.execute("room-c",{kind:"pr",number:7})).resolves.toMatchObject({projection:{repository:"owner/two"},diagnostics:[{cacheOutcome:"miss"}]});
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    const serialized=JSON.stringify(f.service.inspect());expect(serialized).not.toContain(secretOne);expect(serialized).not.toContain(secretTwo);expect(serialized).not.toContain("credential-one");
  });

  it("keeps one global LRU bound across repository scopes",async()=>{
    const f=fixture({maxEntries:1});await f.service.execute("room-a",{kind:"pr",number:7});await f.service.execute("room-c",{kind:"pr",number:7});
    expect(f.service.inspect()).toMatchObject({entries:1});await f.service.execute("room-a",{kind:"pr",number:7});expect(f.fetcher).toHaveBeenCalledTimes(3);
  });

  it("makes old cache entries unreachable after revision change, rebind, disable, drift, or credential loss",async()=>{
    const f=fixture();await f.service.execute("room-a",{kind:"issue",number:9});expect(f.fetcher).toHaveBeenCalledTimes(1);
    const first=f.records.get("project-one")!;f.records.set("project-one",{...first,revision:2,updatedAt:"2026-08-28T00:01:00.000Z"});
    await f.service.execute("room-a",{kind:"issue",number:9});expect(f.fetcher).toHaveBeenCalledTimes(2);
    const revised=f.records.get("project-one")!;f.records.set("project-one",{...revised,connectionId:"connection-rebound",revision:3,remote:{provider:"github",owner:"owner",repository:"rebound",canonical:"github.com/owner/rebound"}});
    await f.service.execute("room-a",{kind:"issue",number:9});expect(String((f.fetcher as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0])).toContain("/owner/rebound/issues/9");
    const rebound=f.records.get("project-one")!;f.records.set("project-one",{...rebound,state:"disabled",revision:4});await expectFailure(f.service.authorize("room-a"),"connection-disabled");
    f.records.set("project-one",{...rebound,state:"identity-drift",revision:5});await expectFailure(f.service.authorize("room-a"),"connection-drift");
    f.records.set("project-one",{...rebound,revision:6,credentialReference:"credential-gone"});await expectFailure(f.service.authorize("room-a"),"credential-missing");
    expect(f.fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([["unknown-room","room-not-found"],["room-general","general-room"],["room-missing-project","project-not-found"],["room-unverified","connection-unverified"],["room-stale","connection-stale"]] as const)("fails closed for %s before upstream access",async(roomId,reason)=>{
    const f=fixture();await expectFailure(f.service.execute(roomId,{kind:"recent"}),reason);expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("retains every #98 command form without exposing credentials, raw payloads, or caller-selected authority",async()=>{
    const f=fixture();const selectors=[{kind:"recent" as const},{kind:"pr" as const,number:7},{kind:"issue" as const,number:9},{kind:"ci" as const},{kind:"ci" as const,number:7}];
    const results=[];for(const selector of selectors)results.push(await f.service.execute("room-a",selector));
    expect(results.map((result)=>result.projection.kind)).toEqual(["recent","pr","issue","ci","ci"]);
    const serialized=JSON.stringify(results);expect(serialized).not.toMatch(/github_pat|credential-one|authorization|cookie|raw secret/i);
    expect((f.fetcher as ReturnType<typeof vi.fn>).mock.calls.every(([,init])=>init?.method==="GET"&&init.body===undefined)).toBe(true);
  });
});

async function expectFailure(promise:Promise<unknown>,kind:string){try{await promise;throw new Error("expected failure");}catch(error){expect(error).toBeInstanceOf(GitHubReadFailure);expect(error).toMatchObject({kind,message:`GitHub read failed (${kind}).`});}}

function response(url:URL){
  const number=Number(url.pathname.split("/").at(-1))||7;
  const pull={number,title:"Bounded pull",state:"open",draft:false,user:{login:"author"},updated_at:"2026-08-28T00:00:00.000Z",base:{ref:"main"},head:{ref:"branch",sha},body:"safe"};
  const issue={number,title:"Bounded issue",state:"open",user:{login:"author"},updated_at:"2026-08-28T00:00:00.000Z",labels:[],comments:0,body:"safe"};
  if(url.pathname.endsWith("/pulls"))return json([pull]);if(/\/pulls\/\d+$/.test(url.pathname))return json(pull);
  if(url.pathname.endsWith("/issues"))return json([issue]);if(/\/issues\/\d+$/.test(url.pathname))return json(issue);
  if(url.pathname.endsWith("/actions/runs"))return json({workflow_runs:[{name:"CI",status:"completed",conclusion:"success",updated_at:"2026-08-28T00:00:00.000Z",head_branch:"main",head_sha:sha}]});
  if(url.pathname.endsWith("/check-runs"))return json({check_runs:[{name:"test",status:"completed",conclusion:"success",completed_at:"2026-08-28T00:00:00.000Z",head_sha:sha,output:{summary:"green"}}]});return new Response("{}",{status:404});
}
function json(value:unknown){return new Response(JSON.stringify(value),{status:200,headers:{"content-type":"application/json"}});}
