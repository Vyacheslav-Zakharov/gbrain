#!/usr/bin/env python3
"""HOSTED ONLY. Real disposable PG16 -> candidate CLI -> CMS -> second isolated cluster.
Never run on a workstation. Failure retains scratch; ephemeral runner is teardown.
"""
import hashlib,json,os,pathlib,pwd,re,shutil,socket,subprocess,sys,tarfile,uuid
import capture
HERE=pathlib.Path(__file__).resolve().parent
PG='/usr/lib/postgresql/16/bin/'
ENV={'PATH':'/usr/bin:/bin','HOME':'/nonexistent','LC_ALL':'C'}
def run(argv):
 try:return subprocess.run(argv,env=ENV,check=True,capture_output=True,text=True,timeout=60).stdout.strip()
 except (subprocess.SubprocessError,OSError):raise capture.Refusal('hosted command failed; command and diagnostics withheld') from None
def pg(tool,*args):return run(['/usr/sbin/runuser','--user','postgres','--',PG+tool,*args])
def main():
 capture.require(os.environ.get('GITHUB_ACTIONS')=='true' and os.geteuid()==0,'hosted root only')
 capture.require(socket.gethostname()!='avers-analyst','production host forbidden')
 capture.require(os.environ.get('GITHUB_REF')=='refs/heads/acceptance/cas-backup-hosted-v1','exact acceptance branch only')
 evidence=pathlib.Path(os.environ['EVIDENCE']);evidence.mkdir(parents=True,exist_ok=True)
 base=pathlib.Path('/tmp/cas-backup-hosted-'+uuid.uuid4().hex);base.mkdir(mode=0o755);base.chmod(0o755)
 user=pwd.getpwnam('postgres');started=False;restore_started=False;success=False
 receipt={'test_only':True,'production_authority':False,'real_pg_restore':False,'source_sha':os.environ['GITHUB_SHA'],'run_id':os.environ['GITHUB_RUN_ID'],'run_attempt':os.environ['GITHUB_RUN_ATTEMPT'],'executor_sha256':capture.hashfile(HERE/'capture.py'),'hosted_sha256':capture.hashfile(HERE/'hosted.py')}
 try:
  for name in ['pgdata','socket']:
   p=base/name;p.mkdir(mode=0o755);os.chown(p,user.pw_uid,user.pw_gid)
  pg('initdb','-D',str(base/'pgdata'),'--auth-local=peer','--auth-host=reject','--no-locale')
  # Dedicated cluster, Unix socket only; never default distro cluster/socket.
  with (base/'pgdata/postgresql.conf').open('a') as f:f.write("\nlisten_addresses = ''\nport = 55439\nunix_socket_directories = '"+str(base/'socket')+"'\n")
  pg('pg_ctl','-D',str(base/'pgdata'),'-l',str(base/'pgdata/server.log'),'-w','start');started=True
  conn=['--host='+str(base/'socket'),'--port=55439','--username=postgres','--no-password']
  pg('createdb',*conn,'cas_backup_source')
  def sql(db,q):return pg('psql','-XAt','-v','ON_ERROR_STOP=1',*conn,'--dbname='+db,'--command='+q)
  sql('cas_backup_source',"CREATE SCHEMA qualification; CREATE TABLE qualification.items(id integer PRIMARY KEY, value text NOT NULL); INSERT INTO qualification.items VALUES (1,'synthetic first'),(2,'synthetic second');")
  sql('cas_backup_source',"CREATE ROLE cas_owner NOLOGIN; CREATE ROLE cas_readers NOLOGIN; CREATE ROLE cas_member LOGIN PASSWORD 'SYNTHETIC-NOT-A-SECRET'; GRANT cas_readers TO cas_member; ALTER DATABASE cas_backup_source OWNER TO cas_owner; ALTER SCHEMA qualification OWNER TO cas_owner; ALTER TABLE qualification.items OWNER TO cas_owner; GRANT USAGE ON SCHEMA qualification TO cas_readers; GRANT SELECT ON qualification.items TO cas_readers;")
  control=pg('pg_controldata',str(base/'pgdata'))
  cluster=re.search(r'^Database system identifier:\s+(\d+)\s*$',control,re.M)[1]
  capture.require(cluster!='7552810389285094085','production cluster forbidden')
  identity=dict(host=socket.gethostname(),database='cas_backup_source',cluster=cluster,boot_id=pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip())
  (base/'roots').mkdir(mode=0o755);roots=[]
  for c in sorted(capture.CATEGORIES):
   p=base/'roots'/c;p.mkdir();(p/'TEST_ONLY.txt').write_text('synthetic '+c+'\n');s=p.stat();roots.append(dict(category=c,path=str(p),dev=s.st_dev,ino=s.st_ino,uid=s.st_uid))
  run(['/usr/bin/openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(base/'private.pem'),'-out',str(base/'recipient.pem'),'-subj','/CN=TEST-ONLY-HOSTED','-days','1'])
  m=dict(schema='cas-local-capture-v1',mode='hosted-disposable',identity=identity,hosted=dict(test_only=True,base=str(base)),roots=roots,allowed_roots=[r['path'] for r in roots],output=str(base/'output'),recipient=str(base/'recipient.pem'),recipient_sha256=capture.hashfile(base/'recipient.pem'),openssl_sha256=capture.hashfile('/usr/bin/openssl'),timeout_seconds=30,max_bytes=16000000,db=dict(argv=[PG+'pg_dump','--format=custom','--no-password','--host='+str(base/'socket'),'--port=55439','--username=postgres','--dbname=cas_backup_source'],executable_sha256=capture.hashfile(PG+'pg_dump'),runuser=dict(path='/usr/sbin/runuser',sha256=capture.hashfile('/usr/sbin/runuser'))))
  m['globals']=dict(argv=[PG+'pg_dumpall','--globals-only','--no-password','--host='+str(base/'socket'),'--port=55439','--username=postgres'],executable_sha256=capture.hashfile(PG+'pg_dumpall'),runuser=dict(m['db']['runuser']))
  capture.durable(base/'TEST_ONLY.json',json.dumps(dict(test_only=True,base=str(base),identity=identity)).encode())
  capture.durable(base/'manifest.json',json.dumps(m).encode())
  # Actual candidate executable, not an imported/mocked capture function.
  run(['/usr/bin/python3','-B',str(HERE/'capture.py'),str(base/'manifest.json'),'--manifest-sha256',capture.hashfile(base/'manifest.json'),'--execute'])
  captured=json.loads((base/'output/capture-manifest.json').read_text())
  assert captured['test_only'] and not captured['production_authority'] and not captured['simulated_db']
  assert captured['ciphertext_sha256']==capture.hashfile(base/'output/payload.cms')
  run(['/usr/bin/openssl','cms','-decrypt','-binary','-inform','DER','-in',str(base/'output/payload.cms'),'-recip',str(base/'recipient.pem'),'-inkey',str(base/'private.pem'),'-out',str(base/'decrypted.tar')])
  with tarfile.open(base/'decrypted.tar') as t:
   data=t.extractfile('database.dump').read();inv=json.load(t.extractfile('inventory.json'))
   assert hashlib.sha256(data).hexdigest()==inv['db_sha256'] and data.startswith(b'PGDMP')
   (base/'restore.dump').write_bytes(data)
   globals_data=t.extractfile('globals.sql').read()
   assert hashlib.sha256(globals_data).hexdigest()==inv['globals_sha256']
   (base/'globals.sql').write_bytes(globals_data)
  (base/'restore.dump').chmod(0o644)
  # SECOND cluster: different bootstrap role avoids CREATE ROLE postgres collision.
  # Trust is confined to a postgres-owned 0700 Unix socket; TCP remains disabled.
  for name in ['restore-pgdata','restore-socket']:
   p=base/name;p.mkdir(mode=0o700);os.chown(p,user.pw_uid,user.pw_gid)
  pg('initdb','-D',str(base/'restore-pgdata'),'--username=cas_restore_admin','--auth-local=trust','--auth-host=reject','--no-locale')
  with (base/'restore-pgdata/postgresql.conf').open('a') as f:f.write("\nlisten_addresses = ''\nport = 55440\nunix_socket_directories = '"+str(base/'restore-socket')+"'\n")
  pg('pg_ctl','-D',str(base/'restore-pgdata'),'-l',str(base/'restore-pgdata/server.log'),'-w','start');restore_started=True
  restore_conn=['--host='+str(base/'restore-socket'),'--port=55440','--username=cas_restore_admin','--no-password']
  restore_cluster=re.search(r'^Database system identifier:\s+(\d+)\s*$',pg('pg_controldata',str(base/'restore-pgdata')),re.M)[1]
  assert restore_cluster!=cluster and restore_cluster!='7552810389285094085'
  def restored(q):return pg('psql','-XAt','-v','ON_ERROR_STOP=1',*restore_conn,'--dbname=cas_backup_restore','--command='+q)
  (base/'globals.sql').chmod(0o600);os.chown(base/'globals.sql',user.pw_uid,user.pw_gid)
  pg('psql','-X','-v','ON_ERROR_STOP=1',*restore_conn,'--dbname=postgres','--file='+str(base/'globals.sql'))
  pg('createdb',*restore_conn,'--owner=cas_owner','cas_backup_restore')
  pg('pg_restore',*restore_conn,'--exit-on-error','--dbname=cas_backup_restore',str(base/'restore.dump'))
  assert restored("SELECT current_setting('data_directory') || '|' || system_identifier::text FROM pg_control_system()") == str(base/'restore-pgdata')+'|'+restore_cluster
  role_checks=[
   "SELECT rolname || ':' || rolcanlogin::text || ':' || rolsuper::text FROM pg_roles WHERE rolname IN ('cas_owner','cas_readers','cas_member') ORDER BY rolname",
   "SELECT r.rolname || ':' || u.rolname || ':' || a.admin_option::text FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles u ON u.oid=a.member WHERE r.rolname='cas_readers' ORDER BY u.rolname",
   "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()",
   "SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='qualification'",
   "SELECT pg_get_userbyid(relowner) || ':' || relacl::text FROM pg_class WHERE oid='qualification.items'::regclass",
   "SELECT has_schema_privilege('cas_member','qualification','USAGE')::text || ':' || has_table_privilege('cas_member','qualification.items','SELECT')::text || ':' || has_table_privilege('cas_member','qualification.items','INSERT')::text",
   "SELECT (rolpassword IS NOT NULL)::text FROM pg_authid WHERE rolname='cas_member'"
  ]
  for query in role_checks:
   before=sql('cas_backup_source',query);after=restored(query)
   assert before and before==after
  assert restored(role_checks[1])=='cas_readers:cas_member:false'
  assert restored(role_checks[2])==restored(role_checks[3])=='cas_owner'
  assert restored(role_checks[5])=='true:true:false'
  assert restored(role_checks[6])=='true'
  receipt.update(real_globals_restore=True,second_cluster=True,restore_cluster=restore_cluster,roles_membership_ownership_grants_equal=True)
  rows="SELECT id::text || ':' || value FROM qualification.items ORDER BY id"
  schema="SELECT table_schema || '.' || table_name || ':' || column_name || ':' || data_type || ':' || is_nullable FROM information_schema.columns WHERE table_schema='qualification' ORDER BY table_name,ordinal_position"
  before=sql('cas_backup_source',rows);after=restored(rows)
  assert before==after and len(before.splitlines())==2
  assert sql('cas_backup_source',schema)==restored(schema)!=''
  receipt.update(real_pg_restore=True,nonempty_rows=2,schema_equal=True,identity=identity,capture_receipt=captured)
  success=True
 finally:
  try:
   try:
    if restore_started:pg('pg_ctl','-D',str(base/'restore-pgdata'),'-m','immediate','-w','stop')
    receipt['restore_cluster_stopped']=True
   finally:
    if started:pg('pg_ctl','-D',str(base/'pgdata'),'-m','immediate','-w','stop')
   receipt['cluster_stopped']=True
   if success:shutil.rmtree(base);receipt['scratch_removed']=not base.exists()
   else:receipt['scratch_retained']=True
  finally:
   target=evidence/'qualification.json';target.write_text(json.dumps(receipt,indent=2));target.chmod(0o644)
 return 0
if __name__=='__main__':
 os.umask(0o077)
 try:sys.exit(main())
 except Exception:
  print('QUALIFICATION_FAILED; diagnostics withheld; inspect private runner scratch',file=sys.stderr);sys.exit(2)
