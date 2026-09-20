"""TEST ONLY disposable PostgreSQL admission; no production authority accepted."""
import os, pathlib, re, socket, stat, tempfile

def grammar(m,args,require):
 require(set(m)=={'schema','mode','identity','hosted','roots','allowed_roots','output','recipient','recipient_sha256','openssl_sha256','timeout_seconds','max_bytes','db'},'hosted manifest fields')
 h=m.get('hosted');require(isinstance(h,dict) and set(h)=={'test_only','base'} and h['test_only'] is True,'explicit test-only admission required')
 base=h['base'];require(isinstance(base,str) and re.fullmatch(r'/tmp/cas-backup-hosted-[a-f0-9]{32}',base),'dedicated disposable base required')
 require(not any([args.authorization,args.authorization_sha256,args.fence,args.fence_sha256,args.fixture_dir]),'production authority forbidden in hosted mode')
 require(not any(k.startswith('PG') or k in ('LD_PRELOAD','LD_LIBRARY_PATH','PYTHONPATH','PYTHONHOME') for k in os.environ),'hosted environment override forbidden')
 i=m['identity'];require(set(i)=={'host','database','cluster','boot_id'} and all(isinstance(v,str) and v for v in i.values()),'hosted identity fields')
 require(i['host']!='avers-analyst' and i['database']=='cas_backup_source' and i['cluster']!='7552810389285094085' and re.fullmatch(r'[0-9]{1,20}',i['cluster']),'production identity forbidden')
 require({r['path'] for r in m['roots']}=={base+'/roots/'+r['category'] for r in m['roots']},'non-disposable source roots')
 require(m['output']==base+'/output' and m['recipient']==base+'/recipient.pem','non-disposable output or recipient')
 db=m['db'];expected=['/usr/lib/postgresql/16/bin/pg_dump','--format=custom','--no-password','--host='+base+'/socket','--port=55439','--username=postgres','--dbname=cas_backup_source']
 require(set(db)=={'argv','executable_sha256','runuser'} and db['argv']==expected,'hosted fixed dump grammar')
 require(set(db['runuser'])=={'path','sha256'} and db['runuser']['path']=='/usr/sbin/runuser','hosted fixed launcher')
 require(all(re.fullmatch('[a-f0-9]{64}',p) for p in [db['executable_sha256'],db['runuser']['sha256'],m['recipient_sha256'],m['openssl_sha256']]),'hosted binary pins')
 return ['/usr/sbin/runuser','--user','postgres','--']+expected

def verify(m,require,safe_path,hashfile,bounded):
 base=safe_path(m['hosted']['base'])
 require(os.geteuid()==0,'hosted capture requires disposable root')
 require(socket.gethostname()==m['identity']['host'] and socket.gethostname()!='avers-analyst','actual host mismatch/production host')
 require(pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()==m['identity']['boot_id'],'actual boot mismatch')
 for p in [base,base/'roots',base/'socket',base/'pgdata']:
  safe_path(str(p));s=p.stat();require(stat.S_ISDIR(s.st_mode) and not s.st_mode&0o022,'unsafe disposable directory')
 require(base.stat().st_uid==0,'disposable base owner')
 marker=base/'TEST_ONLY.json';safe_path(str(marker));s=marker.stat()
 require(stat.S_ISREG(s.st_mode) and s.st_uid==0 and stat.S_IMODE(s.st_mode)==0o600,'test admission marker permissions')
 import json
 require(json.loads(marker.read_text())=={'test_only':True,'base':str(base),'identity':m['identity']},'test admission marker mismatch')
 require(hashfile('/usr/sbin/runuser')==m['db']['runuser']['sha256'],'runuser executable hash mismatch')
 # Independently compare local cluster control data and queried server identity.
 # Fixed SQL and socket only; no arbitrary caller command, URL or environment.
 probe=pathlib.Path(tempfile.mkdtemp(prefix='.identity-',dir=base))
 prefix=['/usr/sbin/runuser','--user','postgres','--']
 bounded(prefix+['/usr/lib/postgresql/16/bin/pg_controldata',str(base/'pgdata')],probe/'control',10,65536)
 control=(probe/'control').read_text()
 match=re.search(r'^Database system identifier:\s+(\d+)\s*$',control,re.M)
 require(match is not None and match[1]==m['identity']['cluster'] and match[1]!='7552810389285094085','actual control identity mismatch/production cluster')
 sql="SELECT current_database() || '|' || current_user || '|' || current_setting('data_directory') || '|' || system_identifier::text FROM pg_control_system()"
 bounded(prefix+['/usr/lib/postgresql/16/bin/psql','-XAt','--no-password','--host='+str(base/'socket'),'--port=55439','--username=postgres','--dbname=cas_backup_source','--command='+sql],probe/'server',10,65536)
 require((probe/'server').read_text().strip()=='cas_backup_source|postgres|'+str(base/'pgdata')+'|'+match[1],'actual server identity mismatch')
 # Probe files deliberately retained on refusal, never infer descendant closure.
 import shutil
 shutil.rmtree(probe)
