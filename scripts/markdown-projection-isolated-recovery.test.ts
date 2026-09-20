import {test,expect} from 'bun:test';
import * as caller from './markdown-projection-isolated-caller';
test('async actual caller preserves verified nonzero admission failure and reaping',async()=>{
 expect(typeof caller.runIsolatedAsync).toBe('function');
 try{await caller.runIsolatedAsync({});throw Error('unexpected success');}
 catch(e:any){expect(e.unsafeFilesystemCleanup).toBe(false);expect(e.receipt.attempts[0].reaped).toBe(true);expect(e.receipt.attempts[0].exitCode).not.toBe(0);expect(e.receipt.attempts[0].errors).toContain('admission_failed');}
});
