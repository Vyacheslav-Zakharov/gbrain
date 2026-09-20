import json, subprocess, unittest
from unittest.mock import patch
import qualify

SCRIPT='/tmp/fixture/globals.sql'
HEADER=b'psql:'+SCRIPT.encode()+b':34: ERROR:  42501: permission denied to grant privileges as role "postgres"'
DETAIL=b'DETAIL:  The grantor must have the ADMIN option on role "cas_readers".'
VALID=HEADER+b'\n'+DETAIL+b'\nLOCATION:  check_role_grantor, user.c:2255\n'

class GrantorDetail(unittest.TestCase):
 def caller(self, stderr):
  argv=['/usr/sbin/runuser','--user','postgres','--',qualify.PG+'psql','-X','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','--file='+SCRIPT]
  with patch.object(qualify,'bounded_globals_run',side_effect=subprocess.CalledProcessError(3,[],stderr=stderr)):
   try:qualify.run(argv)
   except qualify.capture.Refusal as exc:return qualify.failure_diagnostic(exc,'restore-data')
  self.fail('caller did not fail')
 def test_exact_caller(self):
  self.assertEqual(self.caller(VALID)['serverdetail'],'grantor-admin-required')
 def test_unknown_caller(self):
  cases=[VALID+DETAIL+b'\n',VALID+HEADER+b'\n',VALID.replace(b':34:',b':0:'),VALID.replace(b'/fixture/',b'/other/'),VALID.replace(b'42501',b'42710'),VALID.replace(b'postgres',b'other'),VALID.replace(b'cas_readers',b'other'),DETAIL+b'\n'+VALID,VALID.replace(b'\nDETAIL:',b'\nINJECTED\nDETAIL:'),VALID+b'psql:/other/globals.sql:35: ERROR:  42501: injected\n',VALID+b'SECRET_SENTINEL\n',VALID.replace(b'ADMIN option',b'ADMIN options'),b'x'*(qualify.DIAGNOSTIC_LIMIT+1)]
  for data in cases:
   with self.subTest(data=data[:50]):
    result=self.caller(data)
    self.assertEqual(result['serverdetail'],'unknown')
    public=json.dumps(result)
    for forbidden in ['SECRET_SENTINEL','cas_readers','postgres','/tmp/','ADMIN option','injected']:
     self.assertNotIn(forbidden,public)
 def test_receipt_revalidation(self):
  for value in ['SECRET_SENTINEL',True,[],{'secret':'SECRET_SENTINEL'}]:
   exc=qualify.capture.Refusal('SECRET_SENTINEL')
   exc.safe_globals_diagnostic={'sqlstate':'42501','scriptline':34,'serverdetail':value}
   result=qualify.failure_diagnostic(exc,'restore-data')
   self.assertEqual(result['serverdetail'],'unknown')
   self.assertNotIn('SECRET_SENTINEL',json.dumps(result))
