"""Exercise actual main, including all qualification assertions; no DB/processes."""
import ast,io,json,hashlib,pathlib,tempfile,unittest,sys
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import patch
import qualify

class PrimaryPreservation(unittest.TestCase):
 def invoke(self, primary=True, write=False, chmod=False, cleanup=False, cli=False, bootstrap='postgres:10:true'):
  Path=pathlib.Path
  secret='SECRET_SQL_PASSWORD_PATH'
  failure=qualify.capture.Refusal(secret)
  secondary=OSError(secret)
  source_secondary=ValueError(secret)
  stops=[];original_tb=[];receipt_data=[]
  with tempfile.TemporaryDirectory() as td:
   root=Path(td);base=root/'scratch';evidence=root/'evidence'
   def path(v):return base if str(v).startswith('/tmp/cas-backup-hosted-') else Path(v)
   def pg(tool,*args):
    if tool=='initdb' and 'restore-pgdata' in args[1]:
     self.assertIn('--username=postgres',args)
    if tool=='psql' and any(a.startswith('--file=') for a in args):
     self.assertIn('--username=postgres',args)
     self.assertIn('ON_ERROR_STOP=1',args)
     self.assertIn('VERBOSITY=verbose',args)
     self.assertIn('--file='+str(base/'globals-adapted.sql'),args)
     self.assertEqual((base/'globals.sql').read_bytes(),glob)
     self.assertEqual((base/'globals-adapted.sql').read_bytes(),glob.replace(b'CREATE ROLE postgres;',b'',1))
    if tool=='pg_ctl' and args[-1]=='stop':
     stops.append(args[1])
     if cleanup:raise secondary if 'restore-pgdata' in args[1] else source_secondary
    if tool=='pg_controldata':return 'Database system identifier: '+('222' if 'restore-pgdata' in args[0] else '111')
    if tool=='psql' and args[-1].startswith('--command='):
     q=args[-1][10:]
     if 'pg_control_system' in q:return str(base/'restore-pgdata')+'|222'
     if 'bootstrap_identity' in q:return bootstrap if '--dbname=postgres' in args else 'postgres:10:true'
     if 'FROM pg_auth_members' in q:return 'cas_readers:cas_member:false:postgres:10:true:true'
     if 'pg_get_userbyid(datdba)' in q or 'pg_get_userbyid(nspowner)' in q:return 'cas_owner'
     if 'has_schema_privilege' in q:return 'true:true:false'
     if 'rolpassword IS NOT NULL' in q:return 'true'
     if 'SELECT id::text' in q:return '1:first\n2:second'
     if 'information_schema.columns' in q:
      if primary and '--dbname=cas_backup_restore' in args:
       try:raise failure
       except Exception:
        original_tb.append(sys.exc_info()[2]);raise
      return 'schema'
     return 'equal'
    return ''
   data=b'PGDMPsynthetic';glob=b'CREATE ROLE postgres;\nALTER ROLE postgres WITH SUPERUSER;\n'
   inventory={'db_sha256':hashlib.sha256(data).hexdigest(),'globals_sha256':hashlib.sha256(glob).hexdigest()}
   class Archive:
    def __enter__(self):return self
    def __exit__(self,*args):pass
    def extractfile(self,name):return io.BytesIO({'database.dump':data,'globals.sql':glob,'inventory.json':json.dumps(inventory).encode()}[name])
   real_write=Path.write_text;real_chmod=Path.chmod
   def write_text(p,text,*a,**kw):
    if p.name=='qualification.json':
     receipt_data.append(json.loads(text))
     if write:raise secondary
    return real_write(p,text,*a,**kw)
   def do_chmod(p,*a,**kw):
    if p.name=='qualification.json' and chmod:raise secondary
    return real_chmod(p,*a,**kw)
   def run(argv):
    if '--execute' in argv:
     (base/'output').mkdir();(base/'output/capture-manifest.json').write_text(json.dumps({'test_only':True,'production_authority':False,'simulated_db':False,'ciphertext_sha256':'hash'}))
    return ''
   env={'GITHUB_ACTIONS':'true','GITHUB_REF':'refs/heads/acceptance/cas-backup-hosted-v1','EVIDENCE':str(evidence),'GITHUB_SHA':'offline','GITHUB_RUN_ID':'offline','GITHUB_RUN_ATTEMPT':'1'}
   caught=None
   with ExitStack() as stack:
    for manager in [patch.dict(qualify.os.environ,env),patch.object(qualify.socket,'gethostname',return_value='synthetic-offline'),patch.object(qualify.os,'geteuid',return_value=0),patch.object(qualify.os,'chown'),patch.object(qualify.pwd,'getpwnam',return_value=SimpleNamespace(pw_uid=1,pw_gid=1)),patch.object(qualify.pathlib,'Path',side_effect=path),patch.object(qualify,'pg',side_effect=pg),patch.object(qualify,'run',side_effect=run),patch.object(qualify.subprocess,'run',side_effect=AssertionError('NO PROCESS')),patch.object(qualify.capture,'hashfile',return_value='hash'),patch.object(qualify.tarfile,'open',return_value=Archive()),patch.object(Path,'write_text',write_text),patch.object(Path,'chmod',do_chmod)]:stack.enter_context(manager)
    try:
     if cli:
      # Execute the unmodified on-disk CLI guard with actual main and inert dependencies.
      guard=ast.parse(Path(qualify.__file__).read_text()).body[-1]
      with patch.object(qualify.os,'umask'),patch.object(sys,'stderr',new_callable=io.StringIO) as stderr:
       try:exec(compile(ast.Module(body=[guard],type_ignores=[]),qualify.__file__,'exec'),dict(vars(qualify),__name__='__main__'))
       except SystemExit as exc:result=exc.code
       self.assertNotIn(secret,stderr.getvalue())
     else:result=qualify.main()
    except Exception as exc:caught=exc
   self.assertEqual(stops,[str(base/'restore-pgdata'),str(base/'pgdata')])
   if bootstrap!='postgres:10:true':
    self.assertIsInstance(caught,AssertionError)
    self.assertNotIn('bootstrap_adapter',receipt_data[0])
    self.assertFalse(receipt_data[0]['adapted_globals_restore'])
    return
   if cli:self.assertEqual(result,2)
   else:self.assertIs(caught,failure if primary else secondary if write or chmod or cleanup else None)
   if primary:
    tb=caught.__traceback__;chain=[]
    while tb:chain.append(tb);tb=tb.tb_next
    self.assertIn(original_tb[0],chain)
   if receipt_data:
    self.assertEqual(receipt_data[0]['restore_mode'],'adapted-bootstrap-restore')
    self.assertFalse(receipt_data[0]['unmodified_globals_restore'])
    self.assertEqual(receipt_data[0]['bootstrap_adapter']['change_count'],1)
    self.assertNotIn(secret,json.dumps(receipt_data))
    if cleanup:
     self.assertEqual(receipt_data[0]['cleanup_failure']['phase'],'cleanup')
     self.assertEqual(receipt_data[0]['source_cleanup_failure']['phase'],'cleanup')
   if not primary and not (write or chmod or cleanup):self.assertEqual(result,0)
 def test_primary_write(self):self.invoke(write=True)
 def test_primary_chmod(self):self.invoke(chmod=True)
 def test_primary_dual_cleanup(self):self.invoke(cleanup=True)
 def test_primary_all_secondary(self):self.invoke(write=True,cleanup=True)
 def test_success_write_fails(self):self.invoke(primary=False,write=True)
 def test_success_write_cli_nonzero(self):self.invoke(primary=False,write=True,cli=True)
 def test_success_chmod_fails(self):self.invoke(primary=False,chmod=True)
 def test_success_cleanup_fails(self):self.invoke(primary=False,cleanup=True)
 def test_success(self):self.invoke(primary=False)
 def test_wrong_bootstrap_oid_refused(self):self.invoke(primary=False,bootstrap='postgres:99:true')
 def test_wrong_bootstrap_name_refused(self):self.invoke(primary=False,bootstrap='cas_restore_admin:10:true')
 def test_non_superuser_bootstrap_refused(self):self.invoke(primary=False,bootstrap='postgres:10:false')

if __name__=='__main__':unittest.main()
