import contextlib, hashlib, io, json, os, pathlib, shutil, subprocess, sys, tarfile, tempfile, unittest
from unittest.mock import patch
import capture
BASE=pathlib.Path(__file__).resolve().parent
class CaptureTests(unittest.TestCase):
 def setUp(self):
  self.tmp=pathlib.Path(tempfile.mkdtemp(prefix='fixture-',dir=BASE)); self.addCleanup(shutil.rmtree,self.tmp)
  self.key=self.tmp/'TEST_ONLY_PRIVATE_KEY.pem'; self.cert=self.tmp/'TEST_ONLY_RECIPIENT.pem'
  subprocess.run(['/usr/bin/openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(self.key),'-out',str(self.cert),'-subj','/CN=OFFLINE-SIMULATED-DB-ONLY','-days','1'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True)
  os.chmod(self.key,0o600)
  self.stub=self.tmp/'pg_dump_SIMULATED'; self.setstub("import sys\nsys.stdout.buffer.write(b'SIMULATED_DB_NOT_RESTORE_PROOF\\n'+b'D'*1500000)\n")
  roots=[]
  for category in sorted(capture.CATEGORIES):
   p=self.tmp/category;p.mkdir(mode=0o750)
   (p/'data').write_bytes((category+'\n').encode()*50);os.chmod(p/'data',0o640)
   os.utime(p/'data',ns=(1700000000123456789,1700000000123456789))
   st=p.stat();roots.append(dict(category=category,path=str(p),dev=st.st_dev,ino=st.st_ino,uid=st.st_uid))
  self.big=self.tmp/'canonical_roots'/'large';self.big.write_bytes(os.urandom(1200000));os.chmod(self.big,0o600)
  os.link(self.big,self.tmp/'canonical_roots'/'hardlink')
  os.setxattr(self.big,'user.fixture',b'\x00metadata\xff')
  self.m=dict(schema='cas-local-capture-v1',mode='fixture',identity={'fixture':True},roots=roots,allowed_roots=[r['path'] for r in roots],output=str(self.tmp/'out'),recipient=str(self.cert),recipient_sha256=capture.hashfile(self.cert),openssl_sha256=capture.hashfile('/usr/bin/openssl'),timeout_seconds=10,max_bytes=16000000,db={'argv':[str(self.stub),'--simulated-db'],'executable_sha256':capture.hashfile(self.stub)})
  g=self.tmp/'globals_SIMULATED';g.write_text('#!/usr/bin/python3\nprint("SIMULATED_GLOBALS")\n');g.chmod(0o700)
  self.m['globals']={'argv':[str(g),'--simulated-globals'],'executable_sha256':capture.hashfile(g)}
 def setstub(self,body):
  self.stub.write_text('#!/usr/bin/python3\n'+body);self.stub.chmod(0o700)
  if hasattr(self,'m'):self.m['db']['executable_sha256']=capture.hashfile(self.stub)
 def args(self,execute=True):
  p=self.tmp/'input.json';p.write_text(json.dumps(self.m));return [str(p),'--manifest-sha256',capture.hashfile(p),'--fixture-dir',str(self.tmp)]+(['--execute'] if execute else [])
 def run_capture(self,execute=True):
  return subprocess.run([sys.executable,'-B',str(BASE/'capture.py')]+self.args(execute),capture_output=True,text=True,timeout=30)
 def no_complete(self):self.assertFalse((self.tmp/'out'/'COMPLETE').exists())
 def test_end_to_end_large_real_cms_metadata(self):
  p=self.run_capture();self.assertEqual(p.returncode,0,p.stderr)
  out=self.tmp/'out'; self.assertTrue((out/'COMPLETE').exists())
  receipt=json.loads((out/'capture-manifest.json').read_text());self.assertTrue(receipt['simulated_db']);self.assertFalse(receipt['restore_proof']);self.assertGreater(receipt['ciphertext_bytes'],1048576)
  self.assertEqual(receipt['ciphertext_sha256'],capture.hashfile(out/'payload.cms'))
  decrypted=self.tmp/'decrypted.tar'
  subprocess.run(['/usr/bin/openssl','cms','-decrypt','-binary','-inform','DER','-in',str(out/'payload.cms'),'-recip',str(self.cert),'-inkey',str(self.key),'-out',str(decrypted)],check=True)
  with tarfile.open(decrypted) as t:
   inv=json.load(t.extractfile('inventory.json'));self.assertGreater(len(t.extractfile('database.dump').read()),1048576)
   entries={x['name']:x for x in inv['files']}
   for name,meta in entries.items():
    member=t.getmember(name);self.assertEqual(member.mode,meta['mode']);self.assertEqual(member.uid,meta['uid']);self.assertEqual(member.gid,meta['gid'])
    if 'sha256' in meta:self.assertEqual(hashlib.sha256(t.extractfile(name).read()).hexdigest(),meta['sha256'])
   large=[v for k,v in entries.items() if k.endswith('/large')][0]
   self.assertEqual(large['xattrs_base64']['user.fixture'],'AG1ldGFkYXRh/w==')
   self.assertTrue(any('hardlink' in e for e in entries.values()))
   self.assertTrue(any(e['mtime_ns']==1700000000123456789 for e in entries.values()))
  self.assertEqual(out.stat().st_mode&0o777,0o700)
  for f in out.iterdir():self.assertEqual(f.stat().st_mode&0o777,0o600)
  print('PROOF: real CMS decrypt + tar readback; payload >1MiB; simulated DB; hashes, xattr sidecar, hardlinks, ns timestamp, uid/gid/modes checked')
 def test_default_dry_no_export_write(self):
  self.setstub("raise RuntimeError('MUST NOT EXECUTE')")
  p=self.run_capture(False);self.assertEqual(p.returncode,0,p.stderr);self.assertFalse((self.tmp/'out').exists())
 def test_export_failure(self):
  self.setstub("import sys\nsys.stdout.write('partial');sys.exit(17)")
  p=self.run_capture();self.assertEqual(p.returncode,2);self.assertIn('17',p.stderr);self.no_complete();self.assertEqual(list((self.tmp/'out').iterdir()),[])
 def test_encryption_failure(self):
  self.cert.write_text('NOT A CERTIFICATE');self.m['recipient_sha256']=capture.hashfile(self.cert)
  p=self.run_capture();self.assertEqual(p.returncode,2);self.no_complete();self.assertFalse((self.tmp/'out'/'capture-manifest.json').exists())
 def test_timeout(self):
  self.setstub('import time\ntime.sleep(5)');self.m['timeout_seconds']=1
  p=self.run_capture();self.assertEqual(p.returncode,2);self.assertIn('timeout',p.stderr);self.no_complete()
 def test_export_size_bound(self):
  self.m['max_bytes']=1048576;p=self.run_capture();self.assertEqual(p.returncode,2);self.no_complete()
 def test_unknown_root(self):
  self.m['allowed_roots'].pop();p=self.run_capture();self.assertEqual(p.returncode,2);self.assertIn('unknown roots',p.stderr);self.no_complete()
 def test_symlink(self):
  # Root symlinks remain forbidden; child links now have separate positive coverage.
  root=self.tmp/'config'; moved=self.tmp/'config-real'; root.rename(moved); root.symlink_to(moved)
  p=self.run_capture();self.assertEqual(p.returncode,2);self.assertIn('symlink path rejected',p.stderr);self.no_complete()
 def test_fifo(self):
  os.mkfifo(self.tmp/'config'/'fifo');p=self.run_capture();self.assertEqual(p.returncode,2);self.no_complete()
 def test_no_overwrite(self):
  (self.tmp/'out').mkdir();(self.tmp/'out'/'keep').write_text('keep');p=self.run_capture();self.assertEqual(p.returncode,2);self.assertEqual((self.tmp/'out'/'keep').read_text(),'keep');self.no_complete()
 def test_changed_root_identity(self):
  self.m['roots'][0]['ino']+=1;p=self.run_capture();self.assertEqual(p.returncode,2);self.assertIn('identity changed',p.stderr);self.no_complete()
 def test_manifest_hash(self):
  args=self.args();args[2]='0'*64
  p=subprocess.run([sys.executable,'-B',str(BASE/'capture.py')]+args,capture_output=True,text=True);self.assertEqual(p.returncode,2);self.no_complete()
 def test_fixture_escape(self):
  self.m['output']='/tmp/forbidden-backup';p=self.run_capture();self.assertEqual(p.returncode,2);self.assertIn('escaped',p.stderr)
 def test_cleanup_primary_error(self):
  self.setstub('import sys\nsys.exit(19)')
  with patch.object(capture.shutil,'rmtree',side_effect=OSError('cleanup injected')),contextlib.redirect_stderr(io.StringIO()) as err:
   with self.assertRaisesRegex(capture.Refusal,'19'):capture.main(self.args())
  self.assertIn('primary preserved',err.getvalue());self.no_complete()
 def test_production_requires_authority(self):
  # Gate isolated from live paths: mocked hashes only; no process or source open.
  self.m['mode']='production';self.m['identity']={'host':'avers-analyst','database':'gbrain','cluster':'7552810389285094085'}
  self.m['db']['argv']=['/usr/lib/postgresql/16/bin/pg_dump','--format=custom','--no-password','--host=/var/run/postgresql','--port=5432','--username=postgres','--dbname=gbrain']
  self.m['globals']=dict(argv=list(capture.GLOBALS_ARGV),executable_sha256='a'*64,runuser=dict(path='/usr/sbin/runuser',sha256='b'*64))
  with patch.object(capture,'hashfile',return_value='a'*64):
   self.m['db']['executable_sha256']=self.m['recipient_sha256']=self.m['openssl_sha256']='a'*64
   args=self.args();args[2]=hashlib.sha256((self.tmp/'input.json').read_bytes()).hexdigest()
   with self.assertRaisesRegex(capture.Refusal,'authorization'):capture.main(args)
  self.assertFalse((self.tmp/'out').exists())
if __name__=='__main__':unittest.main(verbosity=2)
