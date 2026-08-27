import { GitHubReadFailure, type GitHubEndpointFamily, type GitHubReadAdapter, type GitHubReadQuery, type GitHubSanitizedValue } from "./github-read-adapter.js";

export const DEFAULT_GITHUB_READ_TTL_MS = 60_000;
export const DEFAULT_GITHUB_READ_MAX_ENTRIES = 128;
export const DEFAULT_GITHUB_READ_MAX_ACTIVE = 4;
export const DEFAULT_GITHUB_READ_MAX_QUEUED = 32;

export interface MonotonicClock { now(): number }
export interface GitHubReadDiagnostic { readonly family: GitHubEndpointFamily; readonly cache: "hit" | "miss" | "coalesced" | "refresh"; readonly queueDelayMs: number; readonly rateLimited: boolean; readonly truncated: boolean; readonly failureKind: import("./github-read-adapter.js").GitHubFailureKind | null; readonly statusClass: "none" | "4xx" | "5xx"; readonly correlationId: string }
export interface GitHubReadOutcome { readonly value: GitHubSanitizedValue; readonly diagnostic: GitHubReadDiagnostic }
interface Entry { value: GitHubSanitizedValue; expiresAt: number; touched: number }
interface Pending { readonly promise: Promise<GitHubReadOutcome>; readonly refresh: boolean }
interface QueueItem { readonly start: () => void; readonly enqueuedAt: number }

const performanceClock: MonotonicClock = { now: () => performance.now() };
function positive(value:number|undefined,fallback:number,min:number,max:number){return value===undefined?fallback:Math.max(min,Math.min(max,Math.floor(value)));}
function correlation(family:GitHubEndpointFamily,sequence:number){return `${family}:${sequence.toString(36)}`;}

export class GitHubReadStore {
  private readonly entries=new Map<string,Entry>();
  private readonly pending=new Map<string,Pending>();
  private readonly queue:QueueItem[]=[];
  private readonly ttlMs:number; private readonly maxEntries:number; private readonly maxActive:number; private readonly maxQueued:number;
  private active=0; private touches=0; private sequence=0;
  constructor(private readonly adapter:GitHubReadAdapter, options:{ttlMs?:number;maxEntries?:number;maxActive?:number;maxQueued?:number;clock?:MonotonicClock}={}){this.ttlMs=positive(options.ttlMs,DEFAULT_GITHUB_READ_TTL_MS,1,3_600_000);this.maxEntries=positive(options.maxEntries,DEFAULT_GITHUB_READ_MAX_ENTRIES,1,10_000);this.maxActive=positive(options.maxActive,DEFAULT_GITHUB_READ_MAX_ACTIVE,1,64);this.maxQueued=positive(options.maxQueued,DEFAULT_GITHUB_READ_MAX_QUEUED,0,1_000);this.clock=options.clock||performanceClock;}
  private readonly clock:MonotonicClock;
  key(query:GitHubReadQuery){return `${query.family}\0${this.adapter.normalizedQuery(query)}`;}

  async get(query:GitHubReadQuery):Promise<GitHubReadOutcome>{
    const key=this.key(query);const now=this.clock.now();const existing=this.entries.get(key);const live=this.pending.get(key);const cache=existing&&now<existing.expiresAt?"hit":existing?"refresh":"miss";
    if(existing&&now<existing.expiresAt){existing.touched=++this.touches;return{value:structuredClone(existing.value),diagnostic:{family:query.family,cache:"hit",queueDelayMs:0,rateLimited:false,truncated:Boolean("truncated" in existing.value&&existing.value.truncated),failureKind:null,statusClass:"none",correlationId:correlation(query.family,++this.sequence)}};}
    if(live){const outcome=await live.promise;return{value:structuredClone(outcome.value),diagnostic:{...outcome.diagnostic,cache:"coalesced",correlationId:correlation(query.family,++this.sequence)}};}
    const pending=this.schedule(query,cache==="refresh");this.pending.set(key,{promise:pending,refresh:cache==="refresh"});
    try{return await pending;}finally{this.pending.delete(key);}
  }

  private schedule(query:GitHubReadQuery,refresh:boolean):Promise<GitHubReadOutcome>{
    const enqueuedAt=this.clock.now();const id=correlation(query.family,++this.sequence);
    if(this.active>=this.maxActive&&this.queue.length>=this.maxQueued)return Promise.reject(new GitHubReadFailure("saturated","none"));
    return new Promise((resolve,reject)=>{const start=()=>{this.active++;const queueDelayMs=Math.max(0,this.clock.now()-enqueuedAt);void this.adapter.read(query).then((value)=>{const key=this.key(query);this.entries.set(key,{value:structuredClone(value),expiresAt:this.clock.now()+this.ttlMs,touched:++this.touches});this.evict();resolve({value:structuredClone(value),diagnostic:{family:query.family,cache:refresh?"refresh":"miss",queueDelayMs,rateLimited:false,truncated:Boolean("truncated" in value&&value.truncated),failureKind:null,statusClass:"none",correlationId:id}});},(error)=>reject(error instanceof GitHubReadFailure?error:new GitHubReadFailure("upstream","none"))).finally(()=>{this.active--;this.drain();});};if(this.active<this.maxActive)start();else this.queue.push({start,enqueuedAt});});
  }
  private drain(){while(this.active<this.maxActive&&this.queue.length)this.queue.shift()!.start();}
  private evict(){while(this.entries.size>this.maxEntries){let candidate:string|undefined;let touched=Number.POSITIVE_INFINITY;for(const [key,entry] of this.entries)if(entry.touched<touched){candidate=key;touched=entry.touched;}if(candidate===undefined)return;this.entries.delete(candidate);}}
  invalidate(query:GitHubReadQuery){this.entries.delete(this.key(query));}
  putSanitized(query:GitHubReadQuery,value:GitHubSanitizedValue){if(query.family!==value.family)throw new GitHubReadFailure("configuration","none");const key=this.key(query);this.entries.set(key,{value:structuredClone(value),expiresAt:this.clock.now()+this.ttlMs,touched:++this.touches});this.evict();}
  inspect(){return{entries:this.entries.size,active:this.active,queued:this.queue.length,pending:this.pending.size};}
}
