import json, pathlib, tempfile, unittest
from unittest.mock import patch
from types import SimpleNamespace
import qualify

class Diagnostics(unittest.TestCase):
 def test_no_exception_content_or_arbitrary_class_name(self):
  secret='SECRET_SQL_PASSWORD_PATH'
  cls=type(secret,(RuntimeError,),{})
  try:raise cls(secret)
  except Exception as exc:d=qualify.failure_diagnostic(exc,secret)
  self.assertEqual(d,{'phase':'unknown','kind':'other','frames':[]})
  self.assertNotIn(secret,json.dumps(d))
 def test_record_construction_fault_is_contained(self):
  receipt={}
  with patch.object(qualify,'failure_diagnostic',side_effect=OSError('secret')):
   qualify.record_failure(receipt,'failure',RuntimeError('primary'),'capture')
  self.assertEqual(receipt,{})
 def invoke(self,cleanup_fault=False,diagnostic_fault=False,write_fault=False):
  original_path=pathlib.Path
  with tempfile.TemporaryDirectory() as td:
   root=original_path(td);evidence=root/'evidence';calls=[]
   def path(value):
    if str(value).startswith('/tmp/cas-backup-hosted-'):return root/'scratch'
    return original_path(value)
   primary=qualify.capture.Refusal('SECRET SQL and credentials')
   cleanup=qualify.capture.Refusal('SECRET cleanup')
   def pg(tool,*args):
    calls.append((tool,args))
    if tool=='createdb':raise primary
    if cleanup_fault and tool=='pg_ctl' and args[-1]=='stop':raise cleanup
    return ''
   env={'GITHUB_ACTIONS':'true','GITHUB_REF':'refs/heads/acceptance/cas-backup-hosted-v1','EVIDENCE':str(evidence),'GITHUB_SHA':'offline','GITHUB_RUN_ID':'offline','GITHUB_RUN_ATTEMPT':'1'}
   with patch.dict(qualify.os.environ,env),patch.object(qualify.socket,'gethostname',return_value='synthetic-offline'),patch.object(qualify.os,'geteuid',return_value=0),patch.object(qualify.os,'chown'),patch.object(qualify.pwd,'getpwnam',return_value=SimpleNamespace(pw_uid=1,pw_gid=1)),patch.object(qualify.pathlib,'Path',side_effect=path),patch.object(qualify,'pg',side_effect=pg),patch.object(qualify,'run',side_effect=AssertionError('NO SUBPROCESS ALLOWED')):
    from contextlib import ExitStack
    with ExitStack() as stack:
     if diagnostic_fault:stack.enter_context(patch.object(qualify,'failure_diagnostic',side_effect=RuntimeError('secret')))
     if write_fault:stack.enter_context(patch.object(original_path,'write_text',side_effect=OSError('write fault')))
     with self.assertRaises(Exception) as cm:qualify.main()
   self.assertTrue(any(tool=='pg_ctl' and args[-1]=='stop' for tool,args in calls))
   self.assertIs(cm.exception,primary)
   if write_fault:
    self.assertFalse((evidence/'qualification.json').exists())
   else:
    receipt=json.loads((evidence/'qualification.json').read_text())
    self.assertNotIn('SECRET',json.dumps(receipt))
    self.assertFalse(receipt['real_pg_restore'])
    if diagnostic_fault:self.assertNotIn('failure',receipt)
    else:
     self.assertEqual(receipt['failure']['phase'],'source-seed')
     self.assertEqual(receipt['failure']['kind'],'refusal')
     self.assertTrue(receipt['failure']['frames'])
     self.assertTrue(all(set(f)=={'module','function','line'} for f in receipt['failure']['frames']))
    if cleanup_fault:self.assertEqual(receipt['cleanup_failure']['phase'],'cleanup')
 def test_real_main_primary_and_cleanup(self):self.invoke()
 def test_real_main_secondary_cleanup_failure(self):self.invoke(cleanup_fault=True)
 def test_real_main_diagnostic_fault_cleanup_still_runs(self):self.invoke(diagnostic_fault=True)
 def test_real_main_receipt_write_fault_cleanup_already_ran(self):self.invoke(write_fault=True)

if __name__=='__main__':unittest.main()
