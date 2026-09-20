"""Offline only: real CLI/CMS, simulated SQL; never launch PostgreSQL."""
import contextlib, hashlib, io, json, pathlib, subprocess, sys, tarfile, unittest
from unittest.mock import patch
import capture, test_capture

class GlobalsTests(unittest.TestCase):
 def setUp(self):
  self.t=test_capture.CaptureTests();self.t.setUp();self.addCleanup(self.t.doCleanups)
  self.g=self.t.tmp/'globals_SIMULATED'
  self.body("print('SYNTHETIC_GLOBALS_NOT_RESTORE_PROOF')")
 def body(self,body):
  self.g.write_text('#!/usr/bin/python3\n'+body+'\n');self.g.chmod(0o700)
  self.t.m['globals']={'argv':[str(self.g),'--simulated-globals'],'executable_sha256':capture.hashfile(self.g)}
 def test_globals_in_encrypted_archive_with_hash(self):
  p=self.t.run_capture();self.assertEqual(p.returncode,0,p.stderr)
  dest=self.t.tmp/'plain.tar'
  subprocess.run(['/usr/bin/openssl','cms','-decrypt','-binary','-inform','DER','-in',str(self.t.tmp/'out/payload.cms'),'-recip',str(self.t.cert),'-inkey',str(self.t.key),'-out',str(dest)],check=True,capture_output=True)
  with tarfile.open(dest) as t:
   self.assertIn('globals.sql',t.getnames())
   data=t.extractfile('globals.sql').read();inv=json.load(t.extractfile('inventory.json'))
   self.assertEqual(data,b'SYNTHETIC_GLOBALS_NOT_RESTORE_PROOF\n')
   self.assertEqual(inv['globals_sha256'],hashlib.sha256(data).hexdigest())
  self.assertNotIn('SYNTHETIC_GLOBALS',p.stdout+p.stderr)
  self.assertFalse(list((self.t.tmp/'out').glob('.capture-*')))

 def test_failure_never_logs_sql_or_verifiers(self):
  self.body("import sys;sys.stderr.write('CREATE ROLE secret PASSWORD SCRAM-SHA-256$sentinel');sys.exit(29)")
  p=self.t.run_capture();self.assertEqual(p.returncode,2)
  self.assertNotIn('CREATE ROLE',p.stderr);self.assertNotIn('SCRAM',p.stderr)
  self.t.no_complete();self.assertEqual(list((self.t.tmp/'out').iterdir()),[])

 def test_globals_pin_blocks_all_export(self):
  self.t.m['globals']['executable_sha256']='0'*64
  with patch.object(capture,'bounded') as export:
   with self.assertRaisesRegex(capture.Refusal,'globals executable hash mismatch'):capture.main(self.t.args())
   export.assert_not_called()
  self.assertFalse((self.t.tmp/'out').exists())
 def test_globals_stream_bounds_timeout_empty(self):
  for body,expected in [("import os;os.write(1,b'x'*17000000)",'stdout byte limit'),("import os;os.write(2,b'x'*17000000)",'stderr byte limit'),('import time;time.sleep(5)','timeout'),('pass','empty subprocess output')]:
   with self.subTest(expected=expected):
    self.body(body);self.t.m['timeout_seconds']=1
    p=self.t.run_capture();self.assertEqual(p.returncode,2,p.stderr);self.assertIn(expected,p.stderr);self.t.no_complete()
    self.assertEqual(list((self.t.tmp/'out').iterdir()),[]);(self.t.tmp/'out').rmdir()
 def test_globals_unknown_ownership_retains_private_stage(self):
  original=capture.bounded
  def boundary(argv,out,*args):
   if out.name!='globals.sql':return original(argv,out,*args)
   out.write_bytes(b'SYNTHETIC ONLY');e=capture.Refusal('inert unknown ownership');e.ownership_unknown=True;raise e
  with patch.object(capture,'bounded',side_effect=boundary),contextlib.redirect_stderr(io.StringIO()) as err:
   with self.assertRaisesRegex(capture.Refusal,'inert unknown'):capture.main(self.t.args())
  self.t.no_complete();self.assertIn('OWNERSHIP_UNKNOWN',err.getvalue())
  stages=list((self.t.tmp/'out').glob('.capture-*'));self.assertEqual(len(stages),1);self.assertEqual(stages[0].stat().st_mode&0o777,0o700)
  self.assertTrue((stages[0]/'globals.sql').exists())

class GlobalsGrammar(unittest.TestCase):
 def test_hosted_globals_mutations_refused(self):
  import test_hosted
  t=test_hosted.HostedAdmission()
  for mutate in [lambda m:m['globals']['argv'].append('--file=/tmp/no'),lambda m:m['globals']['argv'].__setitem__(3,'--host=/var/run/postgresql'),lambda m:m['globals'].update(executable_sha256='bad'),lambda m:m['globals']['runuser'].update(sha256='1'*64),lambda m:m['globals'].update(env={'PGHOST':'evil'})]:
   m=t.manifest();mutate(m)
   with self.subTest(mutate=mutate),self.assertRaises(capture.Refusal):t.call(m)
 def test_production_globals_share_exact_authority_and_fence(self):
  import time
  t=test_capture.CaptureTests();t.setUp();self.addCleanup(t.doCleanups)
  t.m['mode']='production';t.m['identity']=dict(host='avers-analyst',database='gbrain',cluster='7552810389285094085')
  for name,argv in [('db',capture.PG_ARGV),('globals',capture.GLOBALS_ARGV)]:
   t.m[name]=dict(argv=list(argv),executable_sha256='a'*64,runuser=dict(path='/usr/sbin/runuser',sha256='b'*64))
  args=t.args();mh=args[2]
  f=t.tmp/'fence.json';f.write_text(json.dumps(dict(manifest_sha256=mh,status='HELD',identity=t.m['identity'],observer='observer',expires_epoch=time.time()+1000)))
  auth=dict(manifest_sha256=mh,executor_sha256=capture.hashfile(capture.__file__),fence_sha256=capture.hashfile(f),action='EXECUTE_LOCAL_ENCRYPTED_CAPTURE',approved=True,reviewer='reviewer',expires_epoch=time.time()+1000)
  a=t.tmp/'auth.json';a.write_text(json.dumps(auth))
  args+=['--authorization',str(a),'--authorization-sha256',capture.hashfile(a),'--fence',str(f),'--fence-sha256',capture.hashfile(f)]
  real=capture.hashfile
  def pins(p,*aa,**kw):
   if str(p) in (capture.PG_ARGV[0],capture.GLOBALS_ARGV[0]):return 'a'*64
   if str(p)=='/usr/sbin/runuser':return 'b'*64
   return real(p,*aa,**kw)
  calls=[]
  def export(argv,out,*aa):
   calls.append(argv)
   if out.name=='database.dump':out.write_bytes(b'SIMULATED');return
   self.assertEqual(argv,['/usr/sbin/runuser','--user','postgres','--']+capture.GLOBALS_ARGV)
   raise capture.Refusal('INERT globals boundary')
  with patch.object(capture,'hashfile',side_effect=pins),patch.object(capture.os,'geteuid',return_value=0),patch.object(capture,'bounded',side_effect=export),contextlib.redirect_stderr(io.StringIO()):
   with self.assertRaisesRegex(capture.Refusal,'INERT globals boundary'):capture.main(args)
  self.assertEqual(len(calls),2);t.no_complete()
  # An exact manifest change invalidates the existing approval before either export.
  t.m['globals']['executable_sha256']='c'*64
  changed=t.args()+args[6:]
  with patch.object(capture,'hashfile',side_effect=lambda p,*aa,**kw:'c'*64 if str(p)==capture.GLOBALS_ARGV[0] else pins(p,*aa,**kw)),patch.object(capture,'bounded') as export:
   with self.assertRaisesRegex(capture.Refusal,'approval binding'):capture.main(changed)
   export.assert_not_called()
 def test_fixed_production_globals(self):
  expected=['/usr/lib/postgresql/16/bin/pg_dumpall','--globals-only','--no-password','--host=/var/run/postgresql','--port=5432','--username=postgres']
  g=dict(argv=expected,executable_sha256='a'*64,runuser=dict(path='/usr/sbin/runuser',sha256='b'*64))
  self.assertTrue(hasattr(capture,'production_globals_launch'),'missing fixed globals grammar')
  self.assertEqual(capture.production_globals_launch(g),['/usr/sbin/runuser','--user','postgres','--']+expected)
  for mutation in [dict(g,argv=expected+['--file=/tmp/escape']),dict(g,argv=expected+['--no-role-passwords']),dict(g,executable_sha256='bad'),dict(g,runuser={'path':'/bin/sh','sha256':'b'*64}),dict(g,extra='bad')]:
   with self.subTest(mutation=mutation),self.assertRaises(capture.Refusal):capture.production_globals_launch(mutation)

if __name__=='__main__':unittest.main()
