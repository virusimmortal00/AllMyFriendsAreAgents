import type { AgentId } from "../shared/participants.js";
import type { RoomRepository } from "./storage/room-repository.js";
import { RoomEventStream } from "./room-event-stream.js";
import type { HumanPresence } from "./types.js";

export interface RoomRuntime {
  readonly roomId:string; readonly repository:RoomRepository; readonly events:Map<string,RoomEventStream>;
  readonly activeGenerations:Map<string,{agent:AgentId;provider:string}>; clients:number; jobs:number; lastUsedAt:number;
  readonly presence:Map<string,{human:HumanPresence;connections:number}>;
}

export class RoomGenerationCapacity {
  private globalActive=0;
  private readonly roomActive=new Map<string,number>();
  private readonly providerActive=new Map<string,number>();
  constructor(private readonly options:{perRoomLimit:number;globalLimit:number;providerLimits:Readonly<Record<string,number>>}){}
  reserve(roomId:string,provider:string){
    const roomCount=this.roomActive.get(roomId)||0,providerCount=this.providerActive.get(provider)||0,providerLimit=this.options.providerLimits[provider]??this.options.globalLimit;
    if(roomCount>=this.options.perRoomLimit||this.globalActive>=this.options.globalLimit||providerCount>=providerLimit)return undefined;
    this.globalActive+=1;this.roomActive.set(roomId,roomCount+1);this.providerActive.set(provider,providerCount+1);let released=false;
    return {release:()=>{if(released)return false;released=true;this.globalActive-=1;const nextRoom=(this.roomActive.get(roomId)||1)-1;if(nextRoom)this.roomActive.set(roomId,nextRoom);else this.roomActive.delete(roomId);const nextProvider=(this.providerActive.get(provider)||1)-1;if(nextProvider)this.providerActive.set(provider,nextProvider);else this.providerActive.delete(provider);return true;}};
  }
  snapshot(){return{globalActive:this.globalActive,roomActive:Object.fromEntries(this.roomActive),providerActive:Object.fromEntries(this.providerActive)};}
}

export class RoomRuntimeRegistry {
  private readonly runtimes=new Map<string,RoomRuntime>();
  private readonly opening=new Map<string,Promise<RoomRuntime>>();
  readonly capacity:RoomGenerationCapacity;
  constructor(private readonly openRepository:(roomId:string)=>Promise<RoomRepository>,private readonly options:{perRoomLimit:number;globalLimit:number;providerLimits:Readonly<Record<string,number>>;dormantAfterMs:number;now?:()=>number},capacity?:RoomGenerationCapacity){this.capacity=capacity||new RoomGenerationCapacity(options);}
  async acquire(roomId:string){let runtime=this.runtimes.get(roomId);if(!runtime){let pending=this.opening.get(roomId);if(!pending){pending=this.openRepository(roomId).then((repository)=>{const created={roomId,repository,events:new Map(),activeGenerations:new Map(),presence:new Map(),clients:0,jobs:0,lastUsedAt:this.now()};this.runtimes.set(roomId,created);this.opening.delete(roomId);return created;},(error)=>{this.opening.delete(roomId);throw error;});this.opening.set(roomId,pending);}runtime=await pending;}runtime.lastUsedAt=this.now();return runtime;}
  stream(runtime:RoomRuntime,humanId:string){let stream=runtime.events.get(humanId);if(!stream){stream=new RoomEventStream(`${runtime.roomId}:${humanId}`);runtime.events.set(humanId,stream);}runtime.lastUsedAt=this.now();return stream;}
  reserve(runtime:RoomRuntime,generationId:string,agent:AgentId,provider:string){
    if(runtime.activeGenerations.has(generationId)||[...runtime.activeGenerations.values()].some((value)=>value.agent===agent))return undefined;
    const capacity=this.capacity.reserve(runtime.roomId,provider);if(!capacity)return undefined;
    runtime.activeGenerations.set(generationId,{agent,provider});runtime.lastUsedAt=this.now();let released=false;
    return {release:()=>{if(released)return false;released=true;const generation=runtime!.activeGenerations.get(generationId);if(!generation){capacity.release();return false;}runtime!.activeGenerations.delete(generationId);capacity.release();runtime!.lastUsedAt=this.now();return true;}};
  }
  releaseDormant(){const released:string[]=[];for(const [roomId,runtime] of this.runtimes){if(runtime.clients||runtime.jobs||runtime.activeGenerations.size||runtime.events.size&&[...runtime.events.values()].some((stream)=>stream.clientCount>0)||this.now()-runtime.lastUsedAt<this.options.dormantAfterMs)continue;(runtime.repository as RoomRepository&{close?:()=>void}).close?.();runtime.events.clear();this.runtimes.delete(roomId);released.push(roomId);}return released;}
  snapshot(){return {runtimeCount:this.runtimes.size,...this.capacity.snapshot(),rooms:Object.fromEntries([...this.runtimes].map(([id,value])=>[id,{clients:value.clients,jobs:value.jobs,presence:value.presence.size,activeGenerations:value.activeGenerations.size,eventStreams:value.events.size}]))};}
  close(){for(const runtime of this.runtimes.values())(runtime.repository as RoomRepository&{close?:()=>void}).close?.();this.runtimes.clear();}
  private now(){return this.options.now?.()??Date.now();}
}
