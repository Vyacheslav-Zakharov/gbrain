import {test,expect} from 'bun:test';
import {admitFixtureFault} from './markdown-projection-fixture-fault';
test('faults require explicit disposable namespace, exact finite seam and UUID',()=>{
 const c={admission:'HOSTED_DISPOSABLE_ONLY',connection:{database:'mp_accept_aabb'},worker:{root:'/tmp/mp-engine-home-ABC123/projection-ABC123'},fixtureFault:{approval:'ISOLATED_RECOVERY_FIXTURE_ONLY',id:'12345678-1234-4234-8234-123456789abc',mode:'backend-loss',seam:'before_write'}};
 expect(admitFixtureFault(c)?.mode).toBe('backend-loss');
 for(const bad of [{...c,admission:'production'},{...c,worker:{root:'/etc'}},{...c,fixtureFault:{...c.fixtureFault,seam:'arbitrary'}},{...c,fixtureFault:{...c.fixtureFault,mode:'exec'}},{...c,fixtureFault:{...c.fixtureFault,id:'../x'}}])expect(()=>admitFixtureFault(bad)).toThrow();
 expect(admitFixtureFault({})).toBeUndefined();
});
