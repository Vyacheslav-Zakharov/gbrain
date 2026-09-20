import contextlib, importlib.util, io, os, pathlib, shutil, subprocess, sys, tempfile, time, unittest
from unittest.mock import patch
import capture
BASE=pathlib.Path(__file__).resolve().parent
RESET='import resource,os,sys,time,signal\nresource.setrlimit(resource.RLIMIT_FSIZE,(resource.RLIM_INFINITY,resource.RLIM_INFINITY))\n'
class OutputTests(unittest.TestCase):
 def setUp(self):
  self.tmp=pathlib.Path(tempfile.mkdtemp(prefix='bounded-',dir=BASE));self.addCleanup(shutil.rmtree,self.tmp)
 def child(self,body):
  return [sys.executable,'-c',RESET+body]
 def test_reset_flood_each_pipe(self):
  for fd in (1,2):
   with self.subTest(fd=fd):
    out=self.tmp/str(fd)
    with self.assertRaisesRegex(capture.Refusal,'byte limit'):
     capture.bounded(self.child(f'os.write(1,b"ok");os.write({fd},b"x"*262144)'),out,2,65536)
    for p in (out,pathlib.Path(str(out)+'.stderr')):self.assertLessEqual(p.stat().st_size,65536)
 def test_dual_pipe_saturation(self):
  out=self.tmp/'dual'
  capture.bounded(self.child('for i in range(128):\n os.write(1,b"x"*4096);os.write(2,b"y"*4096)'),out,3,1048576)
  self.assertEqual(out.stat().st_size,524288);self.assertEqual(pathlib.Path(str(out)+'.stderr').stat().st_size,524288)
 def test_absolute_timeout_term_kill_reap(self):
  pid=self.tmp/'pid';out=self.tmp/'timeout';started=time.monotonic()
  body=f'signal.signal(signal.SIGTERM,signal.SIG_IGN)\nopen({str(pid)!r},"w").write(str(os.getpid()))\nwhile True:\n os.write(1,b"x");time.sleep(.01)'
  with self.assertRaisesRegex(capture.Refusal,'timeout'):capture.bounded(self.child(body),out,.25,1048576)
  self.assertLess(time.monotonic()-started,3)
  with self.assertRaises(ProcessLookupError):os.kill(int(pid.read_text()),0)
 def test_nonzero_reaped_primary_cleanup(self):
  out=self.tmp/'bad'
  with self.assertRaisesRegex(capture.Refusal,r'failed 23 \(diagnostics withheld\)'):
   capture.bounded(self.child('os.write(2,b"original");sys.exit(23)'),out,2,65536)
 def test_registration_failure_reaps_launched_child(self):
  real=subprocess.Popen;children=[]
  def launch(*a,**kw):
   p=real(*a,**kw);children.append(p);return p
  with patch.object(capture.subprocess,'Popen',side_effect=launch),patch.object(capture.selectors.DefaultSelector,'register',side_effect=OSError('registration primary')):
   with self.assertRaisesRegex(OSError,'registration primary'):
    capture.bounded(self.child('time.sleep(3)'),self.tmp/'register',1,65536)
  self.assertEqual(len(children),1);self.assertIsNotNone(children[0].returncode)
 def test_timeout_primary_survives_stage_cleanup_failure(self):
  import test_capture
  t=test_capture.CaptureTests();t.setUp()
  try:
   t.setstub(RESET+'time.sleep(3)');t.m['timeout_seconds']=1
   with patch.object(capture.shutil,'rmtree',side_effect=OSError('cleanup injected')),contextlib.redirect_stderr(io.StringIO()) as err:
    with self.assertRaisesRegex(capture.Refusal,'subprocess timeout'):capture.main(t.args())
   self.assertIn('primary preserved',err.getvalue());t.no_complete()
  finally:t.doCleanups()
 def test_unknown_export_ownership_retains_plaintext(self):
  import test_capture
  t=test_capture.CaptureTests();t.setUp()
  try:
   def unknown(argv,out,*args):
    out.write_bytes(b'partial sensitive fixture');e=capture.Refusal('timeout primary');e.ownership_unknown=True;raise e
   with patch.object(capture,'bounded',side_effect=unknown),contextlib.redirect_stderr(io.StringIO()) as err:
    with self.assertRaisesRegex(capture.Refusal,'timeout primary'):capture.main(t.args())
   self.assertTrue(list((t.tmp/'out').glob('.capture-*/database.dump')))
   self.assertIn('OWNERSHIP_UNKNOWN',err.getvalue());t.no_complete()
  finally:t.doCleanups()
 def test_main_flood_no_oversize_or_complete(self):
  import test_capture
  t=test_capture.CaptureTests();t.setUp()
  try:
   t.setstub(RESET+'os.write(1,b"x"*2097152)');t.m['max_bytes']=1048576;observed=[];real=shutil.rmtree
   def clean(p,*a,**kw):
    observed.extend(f.stat().st_size for f in pathlib.Path(p).glob('database.dump*'))
    return real(p,*a,**kw)
   with patch.object(capture.shutil,'rmtree',side_effect=clean):
    with self.assertRaisesRegex(capture.Refusal,'byte limit'):capture.main(t.args())
   self.assertTrue(observed);self.assertLessEqual(max(observed),1048576);t.no_complete()
  finally:t.doCleanups()

if __name__=='__main__':unittest.main(verbosity=2)
