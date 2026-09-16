import {test,expect} from 'bun:test';
import {runtimeMarkers,verifyRuntimeMarkers,runtimeCLI} from './markdown-projection-runtime-hosted';
test('hosted inventory requires exactly one of every runtime marker',()=>{
 const rows=runtimeMarkers.map(stage=>({stage,status:'passed'}));
 expect(()=>verifyRuntimeMarkers(rows)).not.toThrow();
 for(const row of rows){expect(()=>verifyRuntimeMarkers(rows.filter(r=>r!==row))).toThrow();expect(()=>verifyRuntimeMarkers([...rows,row])).toThrow();}
});
test('actual CLI default-disabled and missing-config refusal without DB',()=>{
 const idle=runtimeCLI('status');expect(idle.exit).toBe(0);expect(JSON.parse(idle.stdout).copyStatus).toBe('not_required');
 const bad=runtimeCLI('drain','/nonexistent/runtime.json');expect(bad.exit).not.toBe(0);
});
