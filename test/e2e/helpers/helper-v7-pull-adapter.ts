import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ids = new Set(['shared', ...['accounting','hr','it','legal','logistics','management','procurement','production','safety','sales-marketing'].map(x=>'internal-'+x)]);
export function parseArgs(args:string[]) {
 if(args.length!==3 || !isAbsolute(args[0]) || !ids.has(args[1]) || !isAbsolute(args[2]) || resolve(args[2])!==args[2]) throw new Error('invalid_adapter_arguments');
 return {runtime:args[0],sourceId:args[1],approvedRoot:args[2]};
}
export function explicitConfig(env:Record<string,string|undefined>,load:()=>any) {
 if(!env.GBRAIN_HOME || !isAbsolute(env.GBRAIN_HOME) || !env.GBRAIN_DATABASE_URL || !/^postgres(?:ql)?:\/\//.test(env.GBRAIN_DATABASE_URL)) throw new Error('explicit_postgres_required');
 const config=load();
 if(!config || config.engine!=='postgres' || config.database_url!==env.GBRAIN_DATABASE_URL || config.database_path || config.remote_mcp) throw new Error('explicit_postgres_required');
 return config;
}
export async function loadRuntime(runtime:string) {
 const load=(name:string)=>import(pathToFileURL(join(runtime,'src/core',name+'.ts')).href);
 const [config,gate,host,remote]=await Promise.all([load('config'),load('page-file-root-gate'),load('page-file-runtime'),load('git-remote')]);
 return {...config,...gate,...host,...remote};
}
// Injection exists only as an exported library seam: CLI has no fixture/module override.
export async function runPull(input:{sourceId:string;approvedRoot:string},engine:any,config:any,api:any) {
 if(engine.kind!=='postgres' || !ids.has(input.sourceId)) throw new Error('explicit_postgres_required');
 const rows=await engine.executeRaw('SELECT id, local_path, config FROM sources WHERE id = $1',[input.sourceId]);
 const root=input.approvedRoot;
 if(rows.length!==1 || rows[0].id!==input.sourceId || rows[0].local_path!==root || !isAbsolute(root) || realpathSync(root)!==root) throw new Error('registered_root_mismatch');
 const host=await api.resolvePageFileRootHost({engine,config},root);
 return await api.withLegacyPageFileRootMutation(engine,root,async(permit:any)=>{
  api.assertPageFileRootPermit(root,permit);
  if(!existsSync(join(root,'.git'))) return {status:'skipped_missing_remote'};
  const git=(args:string[],timeout=15000)=>execFileSync('/usr/bin/git',['-C',root,...args],{encoding:'utf8',timeout,killSignal:'SIGKILL',maxBuffer:4*1024*1024,stdio:['ignore','pipe','pipe'],env:{...process.env,...api.GIT_ENV_AUTH}}).trim();
  const remote=input.sourceId==='shared'?'origin':'github';
  if(!git(['remote']).split('\n').includes(remote)) return {status:'skipped_missing_remote'};
  if(git(['status','--porcelain','--untracked-files=normal'])) return {status:'skipped_dirty'};
  // Validate the actual selected fetch URL (including insteadOf expansion), not origin.
  const urls=git(['remote','get-url','--all',remote]).split('\n');
  if(urls.length!==1) throw new Error('ambiguous_remote');
  api.parseRemoteUrl(urls[0]);
  const before=git(['rev-parse','HEAD']);
  try {
   git([...api.GIT_SSRF_FLAGS,'pull','--ff-only',...api.GIT_SSRF_SUBCOMMAND_FLAGS,remote,'master'],240000);
  } catch { throw new Error('ff_only_pull_failed'); }
  const after=git(['rev-parse','HEAD']);
  return {status:before===after?'up_to_date':'advanced',from:before,to:after};
 },host);
}
export async function main(args:string[], fixture?:{api:any;createEngine:(config:any)=>Promise<any>}) {
 const input=parseArgs(args);
 // Parent enforces 300s process-group timeout including DB/bootstrap/reconciliation.
 // Local watchdog also bounds standalone invocation; no unresolved Promise race.
 const watchdog=setTimeout(()=>process.exit(124),285000);
 let engine:any;
 try {
  const api=fixture?.api ?? await loadRuntime(input.runtime);
  const config=explicitConfig(process.env,api.loadConfig);
  const {createEngine}=fixture ?? await import(pathToFileURL(join(input.runtime,'src/core/engine-factory.ts')).href);
  const engineConfig=api.toEngineConfig(config);
  engine=await createEngine(engineConfig);
  if(engine.kind!=='postgres') throw new Error('explicit_postgres_required');
  await engine.connect(engineConfig);
  const result=await runPull(input,engine,api.loadConfigFileOnly(),api);
  console.log(JSON.stringify(result));
 }finally{try{await engine?.disconnect();}finally{clearTimeout(watchdog);}}
}
if(import.meta.main) main(process.argv.slice(2)).catch(()=>{console.error('[ff-pull] refused or failed; inspect root transition before retry');process.exitCode=1;});
