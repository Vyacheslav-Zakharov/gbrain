#!/usr/bin/env python3
"""HOSTED ONLY. Real disposable PG16 -> candidate CLI -> CMS -> distinct DB.
Never run on a workstation. Failure retains scratch; ephemeral runner is teardown.
"""
import hashlib,json,os,pathlib,pwd,re,shutil,socket,subprocess,sys,tarfile,uuid
import capture
HERE=pathlib.Path(__file__).resolve().parent
PG='/usr/lib/postgresql/16/bin/'
ENV={'PATH':'/usr/bin:/bin','HOME':'/nonexistent','LC_ALL':'C'}
def run(argv):
 return subprocess.run(argv,env=ENV,check=True,capture_output=True,text=True,timeout=60).stdout.strip()
def pg(tool,*args):return run(['/usr/sbin/runuser','--user','postgres','--',PG+tool,*args])
def main():
 capture.require(os.environ.get('GITHUB_ACTIONS')=='true' and os.geteuid()==0,'hosted root only')
 capture.require(socket.gethostname()!='avers-analyst','production host forbidden')
 capture.require(os.environ.get('GITHUB_REF')=='refs/heads/acceptance/cas-backup-hosted-v1','exact acceptance branch only')
 evidence=pathlib.Path(os.environ['EVIDENCE']);evidence.mkdir(parents=True,exist_ok=True)
 base=pathlib.Path('/tmp/cas-backup-hosted-'+uuid.uuid4().hex);base.mkdir(mode=0o755);base.chmod(0o755)
 user=pwd.getpwnam('postgres');started=False;success=False
 receipt={'test_only':True,'production_authority':False,'real_pg_restore':False,'source_sha':os.environ['GITHUB_SHA'],'run_id':os.environ['GITHUB_RUN_ID'],'run_attempt':os.environ['GITHUB_RUN_ATTEMPT'],'executor_sha256':capture.hashfile(HERE/'capture.py'),'hosted_sha256':capture.hashfile(HERE/'hosted.py')}
 try:
  for name in ['pgdata','socket']:
   p=base/name;p.mkdir(mode=0o755);os.chown(p,user.pw_uid,user.pw_gid)
  pg('initdb','-D',str(base/'pgdata'),'--auth-local=peer','--auth-host=reject','--no-locale')
  # Dedicated cluster, Unix socket only; never default distro cluster/socket.
  with (base/'pgdata/postgresql.conf').open('a') as f:f.write("\nlisten_addresses = ''\nport = 55439\nunix_socket_directories = '"+str(base/'socket')+"'\n")
  pg('pg_ctl','-D',str(base/'pgdata'),'-l',str(base/'pgdata/server.log'),'-w','start');started=True
  conn=['--host='+str(base/'socket'),'--port=55439','--username=postgres','--no-password']
  pg('createdb',*conn,'cas_backup_source');pg('createdb',*conn,'cas_backup_restore')
  def sql(db,q):return pg('psql','-XAt','-v','ON_ERROR_STOP=1',*conn,'--dbname='+db,'--command='+q)
  sql('cas_backup_source',"CREATE SCHEMA qualification; CREATE TABLE qualification.items(id integer PRIMARY KEY, value text NOT NULL); INSERT INTO qualification.items VALUES (1,'synthetic first'),(2,'synthetic second');")
  control=pg('pg_controldata',str(base/'pgdata'))
  cluster=re.search(r'^Database system identifier:\s+(\d+)\s*$',control,re.M)[1]
  capture.require(cluster!='7552810389285094085','production cluster forbidden')
  identity=dict(host=socket.gethostname(),database='cas_backup_source',cluster=cluster,boot_id=pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip())
  (base/'roots').mkdir(mode=0o755);roots=[]
  for c in sorted(capture.CATEGORIES):
   p=base/'roots'/c;p.mkdir();(p/'TEST_ONLY.txt').write_text('synthetic '+c+'\n');s=p.stat();roots.append(dict(category=c,path=str(p),dev=s.st_dev,ino=s.st_ino,uid=s.st_uid))
  run(['/usr/bin/openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(base/'private.pem'),'-out',str(base/'recipient.pem'),'-subj','/CN=TEST-ONLY-HOSTED','-days','1'])
  m=dict(schema='cas-local-capture-v1',mode='hosted-disposable',identity=identity,hosted=dict(test_only=True,base=str(base)),roots=roots,allowed_roots=[r['path'] for r in roots],output=str(base/'output'),recipient=str(base/'recipient.pem'),recipient_sha256=capture.hashfile(base/'recipient.pem'),openssl_sha256=capture.hashfile('/usr/bin/openssl'),timeout_seconds=30,max_bytes=16000000,db=dict(argv=[PG+'pg_dump','--format=custom','--no-password','--host='+str(base/'socket'),'--port=55439','--username=postgres','--dbname=cas_backup_source'],executable_sha256=capture.hashfile(PG+'pg_dump'),runuser=dict(path='/usr/sbin/runuser',sha256=capture.hashfile('/usr/sbin/runuser'))))
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
  (base/'restore.dump').chmod(0o644)
  pg('pg_restore',*conn,'--exit-on-error','--dbname=cas_backup_restore',str(base/'restore.dump'))
  rows="SELECT id::text || ':' || value FROM qualification.items ORDER BY id"
  schema="SELECT table_schema || '.' || table_name || ':' || column_name || ':' || data_type || ':' || is_nullable FROM information_schema.columns WHERE table_schema='qualification' ORDER BY table_name,ordinal_position"
  before=sql('cas_backup_source',rows);after=sql('cas_backup_restore',rows)
  assert before==after and len(before.splitlines())==2
  assert sql('cas_backup_source',schema)==sql('cas_backup_restore',schema)!=''
  receipt.update(real_pg_restore=True,nonempty_rows=2,schema_equal=True,identity=identity,capture_receipt=captured)
  success=True
 finally:
  try:
   if started:pg('pg_ctl','-D',str(base/'pgdata'),'-m','immediate','-w','stop')
   receipt['cluster_stopped']=True
   if success:shutil.rmtree(base);receipt['scratch_removed']=not base.exists()
   else:receipt['scratch_retained']=True
  finally:
   target=evidence/'qualification.json';target.write_text(json.dumps(receipt,indent=2));target.chmod(0o644)
 return 0
if __name__=='__main__':
 os.umask(0o077)
 sys.exit(main())
