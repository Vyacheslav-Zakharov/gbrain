import assert from 'node:assert/strict';
let failures=0;
function test(name:string, fn:()=>void) { try { fn(); console.log('PASS',name); } catch(e) { failures++; console.error('FAIL',name,String(e)); process.exitCode=1; } }
const expect=(v:any)=>({toBe:(x:any)=>assert.equal(v,x),toContain:(x:any)=>assert(v.includes(x)),not:{toContain:(x:any)=>assert(!v.includes(x))}});
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const helper=resolve(import.meta.dir,'markdown-projection-engine-admission.ts');
test('namespace admission helper exists (review B1/F2)',()=>expect(existsSync(helper)).toBe(true));
test('migration inventory uses actual config.version and repository expectation',()=>{
 const s=readFileSync(resolve(import.meta.dir,'markdown-projection-engine-hosted.ts'),'utf8');
 expect(s).not.toContain("key='schema_version'");
 expect(s).toContain('LATEST_VERSION');
});
test('relay finally supervisor exists (review F2)',()=>expect(existsSync(resolve(import.meta.dir,'markdown-projection-engine-supervisor.py'))).toBe(true));
const {admitNamespace,assertMigration}=await import('./markdown-projection-engine-admission.ts');
const links=[{ifname:'lo',link_type:'loopback',flags:['UP','LOOPBACK']}];
const status='Uid:\t1001 1001 1001 1001\nGid:\t1001 1001 1001 1001\nGroups:\t\nCapInh:\t0000\nCapPrm:\t0000\nCapEff:\t0000\nCapBnd:\t0000\nCapAmb:\t0000\nNoNewPrivs:\t1';
const admit=(l:unknown=links,r:unknown=[],s=status,n='net:[2]')=>admitNamespace(l,r,[],s,n,'net:[1]','1001','1001');
test('netlink JSON only up loopback and distinct namespace',()=>{admit(JSON.parse(JSON.stringify(links)));assert.throws(()=>admit([...links,{ifname:'eth0'}]));assert.throws(()=>admit([{...links[0],flags:['LOOPBACK']}]));assert.throws(()=>admit(links,[],status,'net:[1]'));});
test('routes reject external/default/multipath and malformed inventories',()=>{admit(links,[{dst:'127.0.0.0/8',dev:'lo',type:'local'}]);for(const r of [[{dev:'eth0',dst:'10.0.0.0/8'}],[{dev:'lo',dst:'default'}],[{dev:'lo',dst:'::/0'}],{},[{dev:'lo',dst:'127.0.0.0/8',nexthops:[]}]])assert.throws(()=>admit(links,r));});
test('wrong identity groups capabilities NoNewPrivs rejected',()=>{for(const s of [status.replace('Uid:\t1001','Uid:\t0'),status.replace('Gid:\t1001','Gid:\t0'),status.replace('Groups:\t','Groups:\t1001'),status.replace('CapEff:\t0000','CapEff:\t0001'),status.replace('NoNewPrivs:\t1','NoNewPrivs:\t0')])assert.throws(()=>admit(links,[],s));});
test('migration rejects old key missing receipt stale version',()=>{assertMigration([{key:'version',value:'42'}],42);for(const rows of [[],[{key:'schema_version',value:'42'}],[{key:'version',value:'41'}]])assert.throws(()=>assertMigration(rows,42));});
