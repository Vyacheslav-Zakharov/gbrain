import {test,expect} from 'bun:test';
import {runIsolated,hostedWorkerMode,removeHostedHome} from './markdown-projection-isolated-caller';
import {mkdtemp,access} from 'node:fs/promises';
test('explicit isolated or legacy mode only',()=>{
 expect(()=>hostedWorkerMode(undefined)).toThrow('explicit');expect(()=>hostedWorkerMode('both')).toThrow('explicit');
 expect(hostedWorkerMode('isolated')).toBe('isolated');expect(hostedWorkerMode('legacy')).toBe('legacy');
});
test('actual supervisor CLI healthy receipt permits filesystem cleanup',async()=>{
 const supervisor=new URL('./markdown-projection-isolated-supervisor.py',import.meta.url).pathname;
 const child=`print('{"stage":"copy.complete","status":"idle"}')`;
 const python=`import importlib.util,sys\ns=importlib.util.spec_from_file_location('m',${JSON.stringify(supervisor)})\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\noriginal=m.run\nm.run=lambda command,config:original([sys.executable,'-c',${JSON.stringify(child)}],config,seconds=.5)\nsys.exit(m.main())`;
 const receipt=runIsolated({},['python3','-B','-c',python]);expect(receipt.status).toBe('passed');expect(receipt.attempts[0].reaped).toBe(true);
 const home=await mkdtemp('/tmp/mp-healthy-');await removeHostedHome(home,undefined);await expect(access(home)).rejects.toThrow();
});
