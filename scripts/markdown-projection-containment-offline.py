#!/usr/bin/env python3
"""Real supervisor CLI -> hosted caller -> retained filesystem; no database."""
import ctypes,importlib.util,json,os,signal,subprocess,sys,tempfile,unittest
from pathlib import Path
REPO=Path(__file__).resolve().parent.parent
class Containment(unittest.TestCase):
 def test_term_resistant_inventory_failure_through_actual_cli_and_caller(self):
  self.assertEqual(ctypes.CDLL(None).prctl(36,1,0,0,0),0)
  with tempfile.TemporaryDirectory(prefix='mp-real-containment-') as d:
   d=Path(d);home=d/'root';home.mkdir();(home/'manual').write_text('manual sentinel')
   pidfile=d/'pid';wrapper=d/'supervisor.py';bridge=d/'caller.ts'
   child="import os,signal,time;from pathlib import Path;signal.signal(signal.SIGTERM,signal.SIG_IGN);Path(%r).write_text(str(os.getpid()));print('{\"stage\":\"copy.complete\",\"status\":\"idle\"}',flush=True);time.sleep(60)"%str(pidfile)
   wrapper.write_text(f'''import importlib.util,sys
s=importlib.util.spec_from_file_location('m',{str(REPO/'scripts/markdown-projection-isolated-supervisor.py')!r})
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
def broken(pid): raise PermissionError('injected inventory failure')
m.reaper.members=broken
original=m.run
m.run=lambda command,config:original([sys.executable,'-c',{child!r}],config,seconds=.25,attempts=2)
sys.exit(m.main())
''')
   bridge.write_text(f'''import {{runIsolated,removeHostedHome}} from {json.dumps(str(REPO/'scripts/markdown-projection-isolated-caller.ts'))};
let failure:any;try{{runIsolated({{}},['python3','-B',{json.dumps(str(wrapper))}]);}}catch(e){{failure=e;}}
let refused=false;try{{await removeHostedHome({json.dumps(str(home))},failure);}}catch{{refused=true;}}
console.log(JSON.stringify({{refused,unsafe:failure?.unsafeFilesystemCleanup,receipt:failure?.receipt,primary:!!failure?.primaryError,cleanup:failure?.cleanupErrors}}));
''')
   pid=None
   try:
    r=subprocess.run(['bun',str(bridge)],capture_output=True,text=True,timeout=10,cwd=REPO)
    self.assertEqual(r.returncode,0,r.stderr);e=json.loads(r.stdout);pid=int(pidfile.read_text())
    os.kill(pid,0)
    self.assertTrue(e['refused']);self.assertTrue(e['unsafe']);self.assertTrue(e['primary']);self.assertTrue(e['cleanup'])
    self.assertEqual((home/'manual').read_text(),'manual sentinel')
    receipt=e['receipt'];self.assertEqual(receipt['status'],'failed');self.assertTrue(receipt['final'])
    self.assertEqual(len(receipt['attempts']),1);a=receipt['attempts'][0]
    self.assertEqual(a['pid'],pid);self.assertEqual(a['runId'],receipt['runId']);self.assertFalse(a['reaped'])
    self.assertIn('lifetime_deadline',a['errors']);self.assertIn('reaping_failed',a['errors'])
    print(json.dumps({'containment':'passed','failedEvidence':e,'manualPreserved':True,'aliveBeforeFixtureCleanup':True}))
   finally:
    if pid is None and pidfile.exists():pid=int(pidfile.read_text())
    if pid:
     os.killpg(pid,signal.SIGKILL);os.waitpid(pid,0)
     with self.assertRaises(ProcessLookupError):os.kill(pid,0)
     print(json.dumps({'fixtureCleanup':'killed-and-reaped','pid':pid}))
if __name__=='__main__':unittest.main()
