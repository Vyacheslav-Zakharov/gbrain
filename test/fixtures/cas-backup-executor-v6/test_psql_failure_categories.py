import unittest, pathlib, importlib.util, sys, subprocess, tempfile, os, stat, json
from unittest.mock import patch
HERE=pathlib.Path(__file__).parent
import qualify as q
class Tests(unittest.TestCase):
 def test_failure_categories_no_raw_output(self):
  secret='SELECT secret; SCRAM-SHA-256$passwordverifier /private/path'
  cases=[(subprocess.CalledProcessError(rc,['secret'],output=secret,stderr=secret),cat) for rc,cat in [(1,'psql-client-or-fatal'),(2,'psql-connection-lost'),(3,'psql-script-error'),(-9,'psql-unclassified'),(77,'psql-unclassified')]]
  cases += [(subprocess.TimeoutExpired(['secret'],60,output=secret,stderr=secret),'psql-timeout'),(OSError(secret),'psql-launch-os-error')]
  for exc,cat in cases:
   with self.subTest(cat=cat),patch.object(q.subprocess,'run',side_effect=exc):
    with self.assertRaises(q.capture.Refusal) as got:q.pg('psql','-X','-v','ON_ERROR_STOP=1','--file=/private/globals.sql')
    d=q.failure_diagnostic(got.exception,'restore-data')
    self.assertEqual(d['failurecategory'],cat)
    self.assertNotIn(secret,json.dumps(d));self.assertNotIn('passwordverifier',json.dumps(d))
 def test_non_psql_and_success(self):
  with patch.object(q.subprocess,'run',side_effect=subprocess.CalledProcessError(3,[])):
   with self.assertRaises(q.capture.Refusal) as got:q.pg('pg_restore')
   self.assertNotIn('failurecategory',q.failure_diagnostic(got.exception,'restore-data'))
  with patch.object(q.subprocess,'run',return_value=subprocess.CompletedProcess([],0,stdout=' ok \n')):self.assertEqual(q.pg('psql'),'ok')
 def test_injected_category_rejected(self):
  e=q.capture.Refusal('secret');e.safe_psql_category='SQL passwordverifier'
  self.assertNotIn('failurecategory',q.failure_diagnostic(e,'restore-data'))
 def test_exact_path_mode_semantics_no_identity_switch(self):
  # Real mkdir/write/chmod under exact CLI umask; no root/runuser/DB.
  # Ownership transition is NOT reproduced; no cross-uid readability claim.
  old=os.umask(0o077)
  try:
   with tempfile.TemporaryDirectory() as td:
    base=pathlib.Path(td)/'base';base.mkdir(mode=0o755);base.chmod(0o755)
    g=base/'globals.sql';g.write_bytes(b'-- synthetic inert fixture\n');g.chmod(0o600)
    sock=base/'restore-socket';sock.mkdir(mode=0o700)
    self.assertEqual(stat.S_IMODE(base.stat().st_mode),0o755)
    self.assertEqual(stat.S_IMODE(g.stat().st_mode),0o600)
    self.assertEqual(stat.S_IMODE(sock.stat().st_mode),0o700)
    self.assertEqual(g.read_bytes(),b'-- synthetic inert fixture\n')
  finally:os.umask(old)
if __name__=='__main__':unittest.main(verbosity=2)
