import assert from 'node:assert/strict';
export function admitNamespace(links: unknown, routes4: unknown, routes6: unknown, status: string, netns: string, hostns: string, uid: string, gid: string) {
 assert(Array.isArray(links) && links.length===1);
 const lo=links[0]; assert.equal(lo.ifname,'lo'); assert.equal(lo.link_type,'loopback'); assert(Array.isArray(lo.flags) && lo.flags.includes('UP') && lo.flags.includes('LOOPBACK'));
 for(const routes of [routes4,routes6]) { assert(Array.isArray(routes)); for(const r of routes) { assert.equal(r.dev,'lo'); assert(['local','broadcast','unicast'].includes(r.type ?? 'unicast')); assert(r.dst && r.dst!=='default' && r.dst!=='0.0.0.0/0' && r.dst!=='::/0'); assert(!r.gateway && !r.nexthops); } }
 assert(/^net:\[\d+\]$/.test(netns)); assert(/^net:\[\d+\]$/.test(hostns)); assert.notEqual(netns,hostns);
 assert(/^[1-9]\d*$/.test(uid)); assert(/^\d+$/.test(gid));
 const fields=Object.fromEntries(status.trim().split('\n').map(l=>{const i=l.indexOf(':');return [l.slice(0,i),l.slice(i+1).trim()];}));
 assert.deepEqual(fields.Uid?.split(/\s+/),[uid,uid,uid,uid]); assert.deepEqual(fields.Gid?.split(/\s+/),[gid,gid,gid,gid]); assert.equal(fields.Groups,'');
 for(const field of ['CapInh','CapPrm','CapEff','CapBnd','CapAmb']) assert(/^0+$/.test(fields[field] ?? ''),field);
 assert.equal(fields.NoNewPrivs,'1');
 return {links,routes4,routes6,netns,hostns,uid:fields.Uid,gid:fields.Gid,groups:fields.Groups,capabilities:Object.fromEntries(Object.entries(fields).filter(([k])=>k.startsWith('Cap'))),NoNewPrivs:fields.NoNewPrivs};
}
export function assertMigration(rows: {key:string,value:string}[], expected:number) {
 assert.equal(rows.length,1); assert.equal(rows[0].key,'version'); assert.equal(rows[0].value,String(expected));
 return {actual:rows[0].value,expected};
}
