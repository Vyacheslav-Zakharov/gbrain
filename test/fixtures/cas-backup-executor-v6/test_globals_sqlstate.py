"""Offline only: synthetic protocol headers; no PostgreSQL invocation."""
import ast,json,pathlib,subprocess,sys,unittest
from unittest.mock import patch
import qualify as q
class SQLStateTests(unittest.TestCase):
 def header(self,code='42710',line='19',message='SENTINEL SQL SCRAM-SHA-256$verifier /private/path'):
  return ('psql:/private/globals.sql:'+line+': ERROR:  '+code+': '+message+'\n').encode()
 def test_all_allowed_codes(self):
  for code,category in q.SQLSTATES.items():
   with self.subTest(code=code):
    d=q.globals_diagnostic(self.header(code),'/private/globals.sql')
    self.assertEqual(d,dict(sqlstate=code,servercategory=category,scriptline=19))
    self.assertNotIn('SENTINEL',json.dumps(d));self.assertNotIn('private',json.dumps(d))
 def test_adversarial_headers_unknown(self):
  good=self.header()
  cases=[b'',None,good.decode(),good*2,b'prefix '+good,good.replace(b'ERROR',b'WARNING'),good.replace(b'/private/globals.sql',b'/wrong'),self.header('ZZ999'),self.header(line='0'),self.header(line='-1'),self.header(line='1'*100),self.header(line='019'),b'x'*65537,good.replace(b'ERROR:  ',b'ERROR: '),good.replace(b'42710',b'4271x'),good.replace(b'19:',b'19\r:'),good.replace(b'psql:',b'\x1bpsql:')]
  for value in cases:
   with self.subTest(value_type=type(value).__name__):
    self.assertEqual(q.globals_diagnostic(value,'/private/globals.sql'),dict(sqlstate='unknown',servercategory='unknown',scriptline=None))
 def test_continuation_sentinels_not_emitted(self):
  value=self.header()+b'LINE 1: SENTINEL SELECT password;\nDETAIL: SCRAM-SHA-256$SENTINEL\nLOCATION: /SENTINEL\n'
  self.assertEqual(q.globals_diagnostic(value,'/private/globals.sql')['sqlstate'],'42710')
 def test_receipt_revalidation(self):
  for value in [dict(sqlstate='SENTINEL',scriptline=1),dict(sqlstate='42710',scriptline=True),dict(sqlstate='42710',scriptline='SENTINEL'),dict(sqlstate='42710',scriptline=10**12)]:
   e=q.capture.Refusal('SENTINEL');e.safe_globals_diagnostic=value
   d=q.failure_diagnostic(e,'restore-data');self.assertEqual(d['sqlstate'],'unknown');self.assertNotIn('SENTINEL',json.dumps(d))
  e=q.capture.Refusal('SENTINEL');e.safe_globals_diagnostic=dict(sqlstate='42501',scriptline=7,servercategory='SENTINEL')
  self.assertEqual(q.failure_diagnostic(e,'restore-data')['servercategory'],'insufficientprivilege')
 def test_run_integration_no_raw_diagnostics(self):
  error=subprocess.CalledProcessError(3,[],stderr=self.header('42601'))
  with patch.object(q,'bounded_globals_run',side_effect=error):
   with self.assertRaises(q.capture.Refusal) as got:q.pg('psql','-X','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','--file=/private/globals.sql')
  d=q.failure_diagnostic(got.exception,'restore-data')
  self.assertEqual(d['servercategory'],'syntax');self.assertEqual(d['scriptline'],19)
  self.assertNotIn('SENTINEL',json.dumps(d));self.assertNotIn('SENTINEL',str(got.exception))
 def test_verbose_only_globals_and_assertions_retained(self):
  tree=ast.parse(pathlib.Path(q.__file__).read_text());calls=[n for n in ast.walk(tree) if isinstance(n,ast.Call) and any(isinstance(a,ast.Constant) and a.value=='VERBOSITY=verbose' for a in n.args)]
  self.assertEqual(len(calls),1)
  self.assertIn('ON_ERROR_STOP=1',[a.value for a in calls[0].args if isinstance(a,ast.Constant)])
  self.assertTrue(any(isinstance(a,ast.BinOp) and isinstance(a.left,ast.Constant) and a.left.value=='--file=' for a in calls[0].args))
 def test_bounded_actual_inert_child(self):
  self.assertEqual(q.bounded_globals_run([sys.executable,'-c','print("ok")']),'ok')
  with self.assertRaises(subprocess.SubprocessError):q.bounded_globals_run([sys.executable,'-c','import sys;sys.stderr.write("SENTINEL"*20000)'])
  with self.assertRaises(subprocess.CalledProcessError) as got:q.bounded_globals_run([sys.executable,'-c','import sys;sys.stderr.write("synthetic");sys.exit(3)'])
  self.assertEqual(got.exception.stderr,b'synthetic')
if __name__=='__main__':unittest.main(verbosity=2)
