import { describe, expect, it } from 'vitest';
import { releasePlan } from './container-release-policy.mjs';
const sha='a'.repeat(40), repository='example/project';
const run={id:1,head_sha:sha,head_branch:'main',head_repository:{full_name:repository},event:'push',status:'completed',conclusion:'success'};
const input={eventName:'workflow_run',event:{workflow_run:run},repository,ref:'refs/heads/main',sha,main:sha,ancestor:true,qualityRuns:[run]};
describe('container publication policy',()=>{
  it('publishes only the exact successful source and promotes current main',()=>expect(releasePlan(input)).toMatchObject({sha,publish:true,promoteMain:true}));
  it('never promotes a stale main build',()=>expect(releasePlan({...input,main:'b'.repeat(40)}).promoteMain).toBe(false));
  it.each([{event:'pull_request'},{head_branch:'feature'},{head_repository:{full_name:'other/fork'}},{conclusion:'failure'},{head_sha:'b'.repeat(40)}])('rejects an untrusted workflow source %j',change=>expect(()=>releasePlan({...input,event:{workflow_run:{...run,...change}}})).toThrow());
  it('rejects a failed latest rerun even if an older run passed',()=>expect(()=>releasePlan({...input,qualityRuns:[run,{...run,id:2,conclusion:'failure'}]})).toThrow());
  it('never gives pull-request builds publication authority',()=>expect(releasePlan({...input,eventName:'pull_request'})).toMatchObject({publish:false,promoteMain:false}));
  it('requires main for dispatch and green exact checks for version tags',()=>{
    expect(()=>releasePlan({...input,eventName:'workflow_dispatch',ref:'refs/heads/feature'})).toThrow();
    expect(()=>releasePlan({...input,eventName:'push',ref:'refs/tags/v1.2.3',qualityRuns:[]})).toThrow();
    expect(releasePlan({...input,eventName:'push',ref:'refs/tags/v1.2.3'})).toMatchObject({version:'1.2.3',promoteMain:false});
  });
  it('rejects unsupported tags and commits outside main',()=>{
    expect(()=>releasePlan({...input,eventName:'push',ref:'refs/tags/vlatest'})).toThrow();
    expect(()=>releasePlan({...input,ancestor:false})).toThrow();
  });
});
