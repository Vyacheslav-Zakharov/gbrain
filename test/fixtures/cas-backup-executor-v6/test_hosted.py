"""Offline admission only; actual identity probes are mocked, never executed."""
import contextlib, io, json, pathlib, tempfile, unittest
from unittest.mock import patch
import capture

class HostedAdmission(unittest.TestCase):
 def manifest(self):
  base='/tmp/cas-backup-hosted-'+'a'*32
  roots=[dict(category=c,path=base+'/roots/'+c,dev=1,ino=i,uid=0) for i,c in enumerate(sorted(capture.CATEGORIES))]
  m=dict(schema='cas-local-capture-v1',mode='hosted-disposable',identity=dict(host='hosted-runner',database='cas_backup_source',cluster='1234567890123456789',boot_id='test-boot'),hosted=dict(test_only=True,base=base),roots=roots,allowed_roots=[r['path'] for r in roots],output=base+'/output',recipient=base+'/recipient.pem',recipient_sha256='0'*64,openssl_sha256='0'*64,timeout_seconds=10,max_bytes=16000000,db=dict(argv=['/usr/lib/postgresql/16/bin/pg_dump','--format=custom','--no-password','--host='+base+'/socket','--port=55439','--username=postgres','--dbname=cas_backup_source'],executable_sha256='0'*64,runuser=dict(path='/usr/sbin/runuser',sha256='0'*64)))
  m['globals']=dict(argv=['/usr/lib/postgresql/16/bin/pg_dumpall','--globals-only','--no-password','--host='+base+'/socket','--port=55439','--username=postgres'],executable_sha256='0'*64,runuser=dict(path='/usr/sbin/runuser',sha256='0'*64))
  return m
 def call(self,m,extra=()):
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d)/'manifest.json';p.write_text(json.dumps(m))
   with contextlib.redirect_stdout(io.StringIO()):
    return capture.main([str(p),'--manifest-sha256',capture.hashfile(p),*extra])
 def test_explicit_hosted_dry_admission_without_export(self):
  # v3 reaches its actual mode refusal: behavioral RED, no absent helper API.
  self.assertEqual(self.call(self.manifest()),0)

 def test_hosted_refuses_unapproved_shapes_before_probes(self):
  for mutate in [lambda m:m.pop('hosted'),lambda m:m['hosted'].update(test_only=False),lambda m:m['identity'].update(host='avers-analyst'),lambda m:m['identity'].update(cluster='7552810389285094085'),lambda m:m['identity'].update(database='gbrain'),lambda m:m['hosted'].update(base='/home/avers'),lambda m:m.update(output='/tmp/not-dedicated'),lambda m:m['db']['argv'].append('--file=/tmp/escape'),lambda m:m['db'].update(env={'PGHOST':'evil'}),lambda m:m.update(command=['sh'])]:
   m=self.manifest();mutate(m)
   with self.subTest(manifest=m),self.assertRaises(capture.Refusal):self.call(m)
 def test_no_production_authority_reuse(self):
  with self.assertRaises(capture.Refusal):self.call(self.manifest(),['--authorization','/tmp/prod'])
 def test_environment_override_refusal(self):
  with patch.dict(capture.os.environ,{'PGHOST':'evil'}),self.assertRaises(capture.Refusal):self.call(self.manifest())

 def test_execute_requires_independent_probe_before_output(self):
  import hosted
  real_hash=capture.hashfile
  with patch.object(capture,'hashfile',side_effect=lambda p,*a,**kw: real_hash(p) if str(p).endswith('manifest.json') else '0'*64),patch.object(hosted,'verify',side_effect=capture.Refusal('actual host mismatch')),patch.object(capture,'bounded') as exporter:
   with self.assertRaisesRegex(capture.Refusal,'actual host mismatch'):self.call(self.manifest(),['--execute'])
   exporter.assert_not_called()

 def test_actual_host_and_boot_are_not_manifest_assertions(self):
  import hosted
  m=self.manifest()
  with patch.object(hosted.os,'geteuid',return_value=0),patch.object(hosted.socket,'gethostname',return_value='avers-analyst'),self.assertRaisesRegex(capture.Refusal,'actual host'):
   hosted.verify(m,capture.require,capture.safe_path,capture.hashfile,lambda *a:self.fail('probe before host guard'))
  with patch.object(hosted.os,'geteuid',return_value=0),patch.object(hosted.socket,'gethostname',return_value='hosted-runner'),patch.object(pathlib.Path,'read_text',return_value='different-boot'),self.assertRaisesRegex(capture.Refusal,'actual boot'):
   hosted.verify(m,capture.require,capture.safe_path,capture.hashfile,lambda *a:self.fail('probe before boot guard'))

if __name__=='__main__':unittest.main()
