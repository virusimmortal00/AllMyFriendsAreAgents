import { commandHelpText, type CommandInput } from "../shared/command-domain.js";
import type { CommandInvoker } from "./command-record.js";
import type { CommandRuntime, CommandResponse } from "./command-runtime.js";
import type { RoomRuntime } from "./room-runtime-registry.js";

/** Serializes short-lived command runtimes per room and closes each one before releasing its repository. */
export class RoomCommandDispatcher {
  private readonly tails=new Map<string,Promise<void>>();
  constructor(private readonly create:(room:RoomRuntime)=>Promise<CommandRuntime>|CommandRuntime){}

  async submit(room:RoomRuntime,input:CommandInput,invoker:CommandInvoker,clientSubmissionId:string):Promise<CommandResponse>{
    const previous=this.tails.get(room.roomId)||Promise.resolve();let release!:()=>void;const gate=new Promise<void>((resolve)=>{release=resolve;});const tail=previous.then(()=>gate);this.tails.set(room.roomId,tail);await previous;
    let runtime:CommandRuntime|undefined;room.jobs+=1;
    try{runtime=await this.create(room);await runtime.initialize();const result=await runtime.submit(input,invoker,clientSubmissionId);if(result.kind==="private-help")await room.repository.addPrivateCommandResponseOnce(result.submissionId,invoker.id,commandHelpText(result.commands));return result;}
    finally{if(runtime)await runtime.close();room.jobs=Math.max(0,room.jobs-1);room.lastUsedAt=Date.now();release();if(this.tails.get(room.roomId)===tail)this.tails.delete(room.roomId);}
  }

  async githubDiagnostic(room:RoomRuntime,invoker:CommandInvoker,submissionId:string){
    const previous=this.tails.get(room.roomId)||Promise.resolve();let release!:()=>void;const gate=new Promise<void>((resolve)=>{release=resolve;});const tail=previous.then(()=>gate);this.tails.set(room.roomId,tail);await previous;
    let runtime:CommandRuntime|undefined;room.jobs+=1;
    try{runtime=await this.create(room);await runtime.initialize();return await runtime.getGhDiagnostic(invoker,submissionId);}
    finally{if(runtime)await runtime.close();room.jobs=Math.max(0,room.jobs-1);room.lastUsedAt=Date.now();release();if(this.tails.get(room.roomId)===tail)this.tails.delete(room.roomId);}
  }

  async close(){await Promise.all(this.tails.values());}
  inspect(){return{activeRooms:this.tails.size};}
}
