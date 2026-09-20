"""Inert oversized metadata plus bounded real stream; no GiB allocation."""
import contextlib, hashlib, io, os, pathlib, tempfile, types, unittest
from unittest.mock import patch
import capture
import test_capture

class PayloadWiring(unittest.TestCase):
 def test_actual_main_authorized_cipher_above_default(self):
  fixture=test_capture.CaptureTests(methodName='test_default_dry_no_export_write')
  fixture.setUp(); self.addCleanup(fixture.doCleanups)
  fixture.m['max_bytes']=4*1073741824
  fixture.m['timeout_seconds']=60
  original=capture.hashfile; seen=[]; statfn=os.fstat
  def hashing(path,*args,**kwargs):
   name=pathlib.Path(path).name
   if name in ('database.dump','globals.sql','payload.cms'):
    seen.append((name,kwargs))
    if name=='payload.cms':
     # Actual helper's admission sees >1GiB; actual reads stay ~3MiB.
     def large_stat(fd):
      st=statfn(fd)
      return types.SimpleNamespace(st_size=1073741825,st_mode=st.st_mode)
     with patch.object(capture.os,'fstat',side_effect=large_stat):
      return original(path,*args,**kwargs)
   return original(path,*args,**kwargs)
  with patch.object(capture,'hashfile',side_effect=hashing),contextlib.redirect_stdout(io.StringIO()):
   self.assertEqual(capture.main(fixture.args()),0)
  self.assertEqual({n for n,k in seen},{'database.dump','globals.sql','payload.cms'})
  for name,kw in seen:
   self.assertEqual(kw['max_bytes'],fixture.m['max_bytes'])
   self.assertGreater(kw['seconds'],0)
   self.assertLessEqual(kw['seconds'],fixture.m['timeout_seconds'])
  self.assertTrue((fixture.tmp/'out/COMPLETE').exists())
  self.assertFalse(list((fixture.tmp/'out').glob('.capture-*')))

class HashBoundaries(unittest.TestCase):
 def test_chunk_exact_and_growth_over_limit(self):
  # fstat lies low to exercise the streaming cap, not just admission.
  for size in (1048575,1048576,1048577):
   for extra in (0,1):
    with self.subTest(size=size,extra=extra):
     data=b'x'*(size+extra); stream=io.BytesIO(data);stream.fileno=lambda:123
     with patch.object(capture,'regular_input',return_value=stream),patch.object(capture.os,'fstat',return_value=types.SimpleNamespace(st_size=0)):
      if extra:
       with self.assertRaisesRegex(capture.Refusal,'hash byte limit'):capture.hashfile('inert',max_bytes=size)
      else:self.assertEqual(capture.hashfile('inert',max_bytes=size),hashlib.sha256(data).hexdigest())
 def test_default_control_cap_retained(self):
  stream=io.BytesIO(b'');stream.fileno=lambda:123
  with patch.object(capture,'regular_input',return_value=stream),patch.object(capture.os,'fstat',return_value=types.SimpleNamespace(st_size=1073741825)):
   with self.assertRaisesRegex(capture.Refusal,'hash byte limit'):capture.hashfile('control')
 def test_explicit_limit_rejects_oversize_and_symlink(self):
  with tempfile.TemporaryDirectory() as td:
   p=pathlib.Path(td)/'data';p.write_bytes(b'ab');link=p.with_name('link');link.symlink_to(p)
   with self.assertRaisesRegex(capture.Refusal,'hash byte limit'):capture.hashfile(p,max_bytes=1)
   with self.assertRaises(OSError):capture.hashfile(link,max_bytes=10)
 def test_explicit_timeout_still_enforced(self):
  with tempfile.NamedTemporaryFile() as f:
   with self.assertRaisesRegex(capture.Refusal,'hash timeout'):capture.hashfile(f.name,max_bytes=10,seconds=0)
