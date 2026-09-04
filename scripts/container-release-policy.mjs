import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function releasePlan({eventName,event,repository,ref,sha,main,ancestor,qualityRuns}) {
  if(!/^[a-f0-9]{40}$/.test(sha))throw new Error('A full source revision is required.');
  if(eventName==='pull_request')return {sha,publish:false,promoteMain:false};
  if(eventName==='workflow_run') {
    const run=event.workflow_run;
    if(run?.event!=='push'||run.head_branch!=='main'||run.head_repository?.full_name!==repository||run.conclusion!=='success'||run.head_sha!==sha)throw new Error('Untrusted quality workflow source.');
  } else if(eventName!=='workflow_dispatch'&&!(eventName==='push'&&/^refs\/tags\/v\d+\.\d+\.\d+$/.test(ref)))throw new Error('Unsupported publication trigger.');
  if(eventName==='workflow_dispatch'&&ref!=='refs/heads/main')throw new Error('Manual publication must run from main.');
  if(!ancestor)throw new Error('Publication source is outside main history.');
  const latest=qualityRuns.filter(r=>r.head_sha===sha&&r.event==='push'&&r.head_branch==='main'&&r.head_repository?.full_name===repository).sort((a,b)=>b.id-a.id)[0];
  if(latest?.status!=='completed'||latest.conclusion!=='success')throw new Error('Exact source quality gate is not green.');
  return {sha,publish:true,promoteMain:sha===main&&!ref.startsWith('refs/tags/'),version:ref.startsWith('refs/tags/')?ref.slice('refs/tags/v'.length):null};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
  const repository=process.env.GITHUB_REPOSITORY;
  const event=JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH,'utf8'));
  const sha=git('rev-parse','HEAD');
  const eventName=process.env.GITHUB_EVENT_NAME;
  const api=endpoint=>JSON.parse(execFileSync('gh',['api',`repos/${repository}/${endpoint}`],{encoding:'utf8'}));
  const main=eventName==='pull_request'?sha:api('commits/main').sha;
  let ancestor=true;
  if(eventName!=='pull_request') {
    execFileSync('git',['fetch','--no-tags','origin','main'],{stdio:'pipe'});
    try{execFileSync('git',['merge-base','--is-ancestor',sha,'FETCH_HEAD']);}catch{ancestor=false;}
  }
  const qualityRuns=eventName==='pull_request'?[]:api(`actions/workflows/quality-gates.yml/runs?head_sha=${sha}&event=push&branch=main&per_page=20`).workflow_runs;
  const plan=releasePlan({eventName,event,repository,ref:process.env.GITHUB_REF,sha,main,ancestor,qualityRuns});
  for(const [key,value] of Object.entries(plan))fs.appendFileSync(process.env.GITHUB_OUTPUT,`${key}=${value??''}\n`);
}
