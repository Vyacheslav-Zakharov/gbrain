import {runIsolated} from './markdown-projection-isolated-caller';
const [action,flag,configPath,...extra]=process.argv.slice(2);
try{
 if(!['status','drain'].includes(action)||extra.length||(flag!==undefined&&(flag!=='--config'||!configPath)))throw Error();
 // No environment configuration discovery; protected file is re-admitted inside each fresh child.
 const receipt=runIsolated({admission:'PROTECTED_RUNTIME_V1',action,...(configPath?{configPath}:{})});
 console.log(JSON.stringify(receipt));
}catch{console.error(JSON.stringify({status:'failed',code:'runtime_failed',durableOutcome:'unknown_consult_ledger'}));process.exitCode=1;}
