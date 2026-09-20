import contextlib, hashlib, io, json, os, pathlib, shutil, subprocess, sys, tempfile, unittest
from unittest.mock import patch
import capture
BASE=pathlib.Path(__file__).resolve().parent

class ShellTests(unittest.TestCase):
 def test_actual_wrapper_missing_and_complete_inert(self):
  with tempfile.TemporaryDirectory(dir=BASE) as d:
   d=pathlib.Path(d); shutil.copy2(BASE/'owner-capture.sh',d/'owner-capture.sh')
   # Actual wrapper bytes; replace ONLY adjacent Python target with an inert argv recorder.
   target=d/'capture.py';target.write_text('import sys,json; print(json.dumps(sys.argv[1:]))\n')
   env={'PATH':'/usr/bin:/bin'}
   p=subprocess.run(['/bin/sh',str(d/'owner-capture.sh')],env=env,capture_output=True,text=True,timeout=3)
   self.assertNotEqual(p.returncode,0);self.assertIn('REVIEWED_MANIFEST',p.stderr)
   values={'REVIEWED_MANIFEST':'/inert/manifest','REVIEWED_MANIFEST_SHA256':'a'*64,'REVIEWED_EXECUTOR_SHA256':hashlib.sha256(target.read_bytes()).hexdigest(),'EXECUTION_AUTHORIZATION':'/inert/auth','EXECUTION_AUTHORIZATION_SHA256':'b'*64,'INDEPENDENT_FENCE_RECEIPT':'/inert/fence','INDEPENDENT_FENCE_RECEIPT_SHA256':'c'*64}
   env.update(values)
   p=subprocess.run(['/bin/sh',str(d/'owner-capture.sh')],env=env,capture_output=True,text=True,timeout=3)
   self.assertEqual(p.returncode,0,p.stderr)
   self.assertEqual(json.loads(p.stdout),['/inert/manifest','--manifest-sha256','a'*64,'--execute','--authorization','/inert/auth','--authorization-sha256','b'*64,'--fence','/inert/fence','--fence-sha256','c'*64])
   for name in values:
    e=env.copy();del e[name]
    p=subprocess.run(['/bin/sh',str(d/'owner-capture.sh')],env=e,capture_output=True,text=True,timeout=3)
    self.assertNotEqual(p.returncode,0);self.assertIn(name,p.stderr)
   env['REVIEWED_EXECUTOR_SHA256']='0'*64
   p=subprocess.run(['/bin/sh',str(d/'owner-capture.sh')],env=env,capture_output=True,text=True,timeout=3)
   self.assertNotEqual(p.returncode,0);self.assertIn('hash mismatch',p.stderr)

class InputTests(unittest.TestCase):
 def test_fifo_inputs_prompt_before_read(self):
  with tempfile.TemporaryDirectory(dir=BASE) as d:
   for kind,fn in [('manifest','load'),('authorization','load'),('fence','load'),('recipient','hashfile'),('executable','hashfile')]:
    with self.subTest(kind=kind):
     p=pathlib.Path(d)/kind;os.mkfifo(p)
     code='import capture; capture.'+fn+'('+repr(str(p))+')'
     try:r=subprocess.run([sys.executable,'-B','-c',code],cwd=BASE,capture_output=True,text=True,timeout=.5)
     except subprocess.TimeoutExpired:self.fail(kind+' blocked opening FIFO')
     self.assertNotEqual(r.returncode,0);self.assertIn('not regular input',r.stderr)
 def test_hash_stream_limit_deadline_symlink(self):
  with tempfile.TemporaryDirectory(dir=BASE) as d:
   p=pathlib.Path(d)/'data';p.write_bytes(b'x'*2000000)
   self.assertEqual(capture.hashfile(p),hashlib.sha256(p.read_bytes()).hexdigest())
   with self.assertRaisesRegex(capture.Refusal,'hash byte limit'):capture.hashfile(p,max_bytes=100)
   with self.assertRaisesRegex(capture.Refusal,'hash timeout'):capture.hashfile(p,seconds=0)
   link=pathlib.Path(d)/'link';link.symlink_to(p)
   with self.assertRaises(OSError):capture.hashfile(link)

class ArchiveTests(unittest.TestCase):
 def test_headers_inventory_never_exceed_tar_budget(self):
  import test_capture
  t=test_capture.CaptureTests();t.setUp()
  try:
   t.setstub("print('SIMULATED')")
   t.big.unlink();(t.tmp/'canonical_roots'/'hardlink').unlink()
   for i in range(600):(t.tmp/'config'/(str(i)+'x'*230)).touch()
   t.m['max_bytes']=1048576;observed=[];real=shutil.rmtree
   def cleanup(p,*a,**kw):
    tar=pathlib.Path(p)/'payload.tar'
    if tar.exists():observed.append(tar.stat().st_size)
    return real(p,*a,**kw)
   with patch.object(capture.shutil,'rmtree',side_effect=cleanup):
    with self.assertRaises(capture.Refusal):capture.main(t.args())
   self.assertTrue(observed);self.assertLessEqual(max(observed),1048576);t.no_complete()
  finally:t.doCleanups()
 def test_deadline_per_tar_write_chunk(self):
  import tarfile
  class Clock:
   now=0
  clock=Clock()
  class Sink(io.BytesIO):
   def write(self,b):
    clock.now+=1;return super().write(b)
  sink=Sink()
  # Writer is the same wrapper used by production tarfile, not a fake archive.
  with patch.object(capture.time,'monotonic',side_effect=lambda:clock.now):
   writer=capture.ArchiveWriter(sink,10000000,2)
   with self.assertRaisesRegex(capture.Refusal,'archive timeout'):
    with tarfile.open(fileobj=writer,mode='w',format=tarfile.PAX_FORMAT) as tar:
     member=tarfile.TarInfo('large');member.size=2000000
     tar.addfile(member,io.BytesIO(b'x'*member.size))
  self.assertLess(sink.tell(),2000000)

class LaunchTests(unittest.TestCase):
 def test_main_pins_and_authority_before_inert_export(self):
  import test_capture, time
  t=test_capture.CaptureTests();t.setUp()
  try:
   t.m['mode']='production';t.m['identity']={'host':'avers-analyst','database':'gbrain','cluster':'7552810389285094085'}
   t.m['db']={'argv':list(capture.PG_ARGV),'executable_sha256':'a'*64,'runuser':{'path':'/usr/sbin/runuser','sha256':'b'*64}}
   args=t.args();mh=args[2]
   fence={'manifest_sha256':mh,'status':'HELD','identity':t.m['identity'],'observer':'observer','expires_epoch':time.time()+1000}
   f=t.tmp/'fence.json';f.write_text(json.dumps(fence));fh=hashlib.sha256(f.read_bytes()).hexdigest()
   auth={'manifest_sha256':mh,'executor_sha256':capture.hashfile(capture.__file__),'fence_sha256':fh,'action':'EXECUTE_LOCAL_ENCRYPTED_CAPTURE','approved':True,'reviewer':'reviewer','expires_epoch':time.time()+1000}
   a=t.tmp/'auth.json';a.write_text(json.dumps(auth));ah=hashlib.sha256(a.read_bytes()).hexdigest()
   args+=['--authorization',str(a),'--authorization-sha256',ah,'--fence',str(f),'--fence-sha256',fh]
   real=capture.hashfile
   def pins(p,*aa,**kw):
    if str(p)==capture.PG_ARGV[0]:return 'a'*64
    if str(p)=='/usr/sbin/runuser':return '0'*64
    return real(p,*aa,**kw)
   with patch.object(capture,'hashfile',side_effect=pins),patch.object(capture.os,'geteuid',return_value=0),patch.object(capture,'bounded') as export:
    with self.assertRaisesRegex(capture.Refusal,'runuser executable hash mismatch'):capture.main(args)
    export.assert_not_called();self.assertFalse((t.tmp/'out').exists())
   def validpins(p,*aa,**kw):
    if str(p)=='/usr/sbin/runuser':return 'b'*64
    return pins(p,*aa,**kw)
   def inert(argv,*aa):
    self.assertEqual(argv,['/usr/sbin/runuser','--user','postgres','--']+capture.PG_ARGV)
    raise capture.Refusal('INERT export boundary; no process launched')
   with patch.object(capture,'hashfile',side_effect=validpins),patch.object(capture.os,'geteuid',return_value=0),patch.object(capture,'bounded',side_effect=inert):
    with self.assertRaisesRegex(capture.Refusal,'INERT'):capture.main(args)
   t.no_complete()
  finally:t.doCleanups()

 def test_exact_runuser_export_grammar_inert_recorder(self):
  pg=['/usr/lib/postgresql/16/bin/pg_dump','--format=custom','--no-password','--host=/var/run/postgresql','--port=5432','--username=postgres','--dbname=gbrain']
  db={'argv':pg,'executable_sha256':'a'*64,'runuser':{'path':'/usr/sbin/runuser','sha256':'b'*64}}
  argv=capture.production_launch(db)
  self.assertEqual(argv,['/usr/sbin/runuser','--user','postgres','--']+pg)
  with tempfile.TemporaryDirectory(dir=BASE) as d:
   d=pathlib.Path(d);rec=d/'recorder.py';rec.write_text('import sys,json; print(json.dumps(sys.argv[1:]))')
   real=subprocess.Popen
   def inert(actual,**kwargs):
    self.assertEqual(actual,argv)
    return real([sys.executable,str(rec)]+actual,**kwargs)
   with patch.object(capture.subprocess,'Popen',side_effect=inert):capture.bounded(argv,d/'argv.json',3,1048576)
   self.assertEqual(json.loads((d/'argv.json').read_text()),argv)
  for mutation in [dict(db,argv=pg+['--file=/tmp/no']),dict(db,runuser={'path':'/bin/sh','sha256':'b'*64}),dict(db,runuser={'path':'/usr/sbin/runuser','sha256':'bad'})]:
   with self.assertRaises(capture.Refusal):capture.production_launch(mutation)

if __name__=='__main__':unittest.main(verbosity=2)
