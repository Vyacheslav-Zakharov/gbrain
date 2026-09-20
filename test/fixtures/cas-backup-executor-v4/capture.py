#!/usr/bin/env python3
"""Development candidate: local encrypted capture, NOT restore or install authority."""
import argparse, base64, hashlib, json, os, pathlib, selectors, shutil, stat, subprocess, sys, tarfile, tempfile, time
CATEGORIES = {'runtime','config','dependencies','canonical_roots','git_state','archive_objects','roles_acl'}
class Refusal(Exception): pass
def require(ok, msg):
    if not ok: raise Refusal(msg)
def digest(data): return hashlib.sha256(data).hexdigest()
def unique(pairs):
    d = {}
    for k,v in pairs:
        require(k not in d, 'duplicate JSON key'); d[k]=v
    return d
def regular_input(path):
    fd = os.open(path, os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        require(stat.S_ISREG(os.fstat(fd).st_mode),'not regular input')
        return os.fdopen(fd,'rb')
    except BaseException:
        os.close(fd); raise

def load(path):
    with regular_input(path) as f:
        b=f.read(1048577); require(len(b)<=1048576,'oversized JSON')
    return json.loads(b,object_pairs_hook=unique),digest(b)
def hashfile(path, max_bytes=1073741824, seconds=30):
    h=hashlib.sha256(); count=0; deadline=time.monotonic()+seconds
    with regular_input(path) as f:
        require(os.fstat(f.fileno()).st_size<=max_bytes,'hash byte limit')
        while True:
            require(time.monotonic()<deadline,'hash timeout')
            b=f.read(min(1048576,max_bytes-count+1))
            require(time.monotonic()<deadline,'hash timeout')
            count+=len(b); require(count<=max_bytes,'hash byte limit')
            if not b: break
            h.update(b)
    return h.hexdigest()
class ArchiveWriter:
    """Cooperative per-chunk bounds; blocking kernel calls need an external watchdog."""
    def __init__(self, raw, limit, deadline):
        self.raw=raw; self.limit=limit; self.deadline=deadline; self.count=0
    def check(self): require(time.monotonic()<self.deadline,'archive timeout')
    def tell(self): return self.count
    def write(self, data):
        self.check()
        require(self.count+len(data)<=self.limit,'archive byte limit')
        view=memoryview(data)
        for start in range(0,len(view),65536):
            self.check(); chunk=view[start:start+65536]
            n=self.raw.write(chunk); self.count+=n
            require(n==len(chunk),'short archive write'); self.check()
        return len(data)

def safe_path(path):
    p=pathlib.Path(path)
    require(p.is_absolute() and '..' not in p.parts and str(p)==path,'noncanonical absolute path')
    cur=pathlib.Path('/')
    for part in p.parts[1:]:
        cur/=part
        require(not cur.is_symlink(),'symlink path rejected')
    return p
def fsync_dir(p):
    fd=os.open(p,os.O_RDONLY|os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)
def durable(path, data):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'wb') as f: f.write(data); f.flush(); os.fsync(f.fileno())
def bounded(argv, out, seconds, limit):
    # Parent owns both files; child receives pipes only. No inherited FSIZE reliance.
    # Deadline covers pipe draining AND direct-child exit, not blocking disk syscalls.
    deadline=time.monotonic()+seconds
    with selectors.DefaultSelector() as sel, open(out,'xb',buffering=0) as f, open(str(out)+'.stderr','xb',buffering=0) as err:
        os.chmod(out,0o600); os.chmod(str(out)+'.stderr',0o600)
        p=None; primary=None
        try:
            p=subprocess.Popen(argv,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                env={'PATH':'/usr/bin:/bin','LC_ALL':'C','HOME':'/nonexistent'},shell=False,bufsize=0)
            for pipe,sink,name in ((p.stdout,f,'stdout'),(p.stderr,err,'stderr')):
                os.set_blocking(pipe.fileno(),False)
                sel.register(pipe,selectors.EVENT_READ,[sink,name,0])
            while sel.get_map():
                remaining=deadline-time.monotonic()
                require(remaining>0,'subprocess timeout')
                for key,_ in sel.select(remaining):
                    require(time.monotonic()<deadline,'subprocess timeout')
                    sink,name,count=key.data
                    try: chunk=os.read(key.fd,min(65536,limit-count+1))
                    except BlockingIOError: continue
                    if not chunk:
                        sel.unregister(key.fileobj); continue
                    # Count BEFORE writing: even the violating chunk never reaches disk.
                    key.data[2]+=len(chunk)
                    require(key.data[2]<=limit,'subprocess '+name+' byte limit')
                    require(sink.write(chunk)==len(chunk),'short subprocess output write')
            try: p.wait(timeout=max(0,deadline-time.monotonic()))
            except subprocess.TimeoutExpired: raise Refusal('subprocess timeout')
            require(time.monotonic()<deadline,'subprocess timeout')
            with open(str(out)+'.stderr','rb') as e: detail=e.read(2048).decode(errors='replace')
            require(p.returncode==0,'subprocess failed '+str(p.returncode)+': '+detail)
            os.fsync(f.fileno())
            require(os.path.getsize(out)>0,'empty subprocess output')
        except BaseException as e:
            primary=e
            raise
        finally:
            if p is not None:
                # Only direct-child ownership is established here. Never claim a tree reap.
                try:
                    if p.poll() is None:
                        try: p.terminate()
                        except ProcessLookupError: pass
                        try: p.wait(timeout=.25)
                        except subprocess.TimeoutExpired:
                            try: p.kill()
                            except ProcessLookupError: pass
                            p.wait(timeout=1)
                    else: p.wait()
                except BaseException as cleanup:
                    if primary is not None:
                        primary.ownership_unknown=True
                        print('CHILD_STOP_FAILED (primary preserved): '+str(cleanup),file=sys.stderr)
                    else:
                        failure=Refusal('child stop failed; ownership unknown')
                        failure.ownership_unknown=True
                        raise failure from cleanup
                finally:
                    for pipe in (p.stdout,p.stderr):
                        if pipe is not None: pipe.close()
PG_ARGV=['/usr/lib/postgresql/16/bin/pg_dump','--format=custom','--no-password','--host=/var/run/postgresql','--port=5432','--username=postgres','--dbname=gbrain']
def production_launch(db):
    require(db['argv']==PG_ARGV,'noncanonical pg_dump argv')
    launcher=db.get('runuser',{})
    require(set(launcher)=={'path','sha256'} and launcher.get('path')=='/usr/sbin/runuser','noncanonical runuser launcher')
    pin=launcher['sha256']
    require(isinstance(pin,str) and len(pin)==64 and all(c in '0123456789abcdef' for c in pin),'invalid runuser hash pin')
    return [launcher['path'],'--user','postgres','--']+PG_ARGV

def main(argv=None):
    a=argparse.ArgumentParser()
    a.add_argument('manifest'); a.add_argument('--manifest-sha256',required=True)
    a.add_argument('--execute',action='store_true'); a.add_argument('--fixture-dir')
    a.add_argument('--authorization'); a.add_argument('--authorization-sha256')
    a.add_argument('--fence'); a.add_argument('--fence-sha256')
    args=a.parse_args(argv)
    m,mh=load(args.manifest); require(mh==args.manifest_sha256,'manifest hash mismatch')
    require(m['schema']=='cas-local-capture-v1','schema')
    require(m['mode'] in ('fixture','production','hosted-disposable'),'mode')
    require(set(x['category'] for x in m['roots'])==CATEGORIES,'missing/unknown categories')
    require(len({x['path'] for x in m['roots']})==len(m['roots']),'duplicate roots')
    require(all(set(x)=={'category','path','dev','ino','uid'} for x in m['roots']),'root fields')
    require(set(m['allowed_roots'])=={x['path'] for x in m['roots']},'unknown roots')
    paths=[str(safe_path(x['path'])) for x in m['roots']]
    require('/' not in paths,'filesystem root forbidden')
    require(all(not (p!=q and pathlib.Path(p).is_relative_to(q)) for p in paths for q in paths),'overlapping roots')
    require(1<=m['timeout_seconds']<=3600 and 1048576<=m['max_bytes']<=1099511627776,'invalid bounds')
    output=safe_path(m['output']); recipient=safe_path(m['recipient'])
    require(not any(output.is_relative_to(p) for p in paths),'output inside source')
    db=m['db']; exe=str(safe_path(db['argv'][0]))
    if m['mode']=='production':
        require(m['identity']=={'host':'avers-analyst','database':'gbrain','cluster':'7552810389285094085'},'target identity')
        require(db['argv']==PG_ARGV,'noncanonical pg_dump argv')
    elif m['mode']=='hosted-disposable':
        import hosted
        hosted.grammar(m,args,require)
    else:
        require(args.fixture_dir is not None,'fixture isolation required')
        fixture=safe_path(args.fixture_dir)
        require(fixture.is_relative_to(pathlib.Path(__file__).resolve().parent),'fixture outside packet')
        require(all(pathlib.Path(p).is_relative_to(fixture) for p in paths+[str(output),str(recipient),exe]),'fixture escaped')
        require(db['argv']==[exe,'--simulated-db'],'noncanonical simulated DB argv')
    if not args.execute:
        print(json.dumps({'status':'DRY_PREFLIGHT_ONLY','source_content_reads':False,'export':False,'network':False,'writes':False,'manifest_sha256':mh}))
        return 0
    require(hashfile(exe)==db['executable_sha256'],'export executable hash mismatch')
    require(hashfile(recipient)==m['recipient_sha256'],'recipient mismatch')
    require(hashfile('/usr/bin/openssl')==m['openssl_sha256'],'openssl mismatch')
    if m['mode']=='production':
        require(all([args.authorization,args.authorization_sha256,args.fence,args.fence_sha256]),'reviewed authorization and independent fence required')
        auth,ah=load(args.authorization); fence,fh=load(args.fence)
        require(ah==args.authorization_sha256 and fh==args.fence_sha256,'receipt hash mismatch')
        require(auth['manifest_sha256']==mh and auth['executor_sha256']==hashfile(__file__) and auth['fence_sha256']==fh,'approval binding')
        require(auth['action']=='EXECUTE_LOCAL_ENCRYPTED_CAPTURE' and auth['approved'] is True,'execution not authorized')
        require(auth['reviewer']!=fence['observer'] and bool(auth['reviewer']) and bool(fence['observer']),'independent review required')
        require(fence['manifest_sha256']==mh and fence['status']=='HELD' and fence['identity']==m['identity'],'fence binding')
        require(time.time()+m['timeout_seconds']*3 < min(auth['expires_epoch'],fence['expires_epoch']),'receipt expiry')
    launch=db['argv']
    if m['mode']=='production':
        launch=production_launch(db)
        require(os.geteuid()==0,'production filesystem capture requires root; only export switches identity')
        require(hashfile(safe_path(db['runuser']['path']))==db['runuser']['sha256'],'runuser executable hash mismatch')
    if m['mode']=='hosted-disposable':
        launch=hosted.grammar(m,args,require)
        hosted.verify(m,require,safe_path,hashfile,bounded)
    # Reserve the final directory atomically; never overwrite even a failed attempt.
    output.mkdir(mode=0o700,parents=False); fsync_dir(output.parent)
    stage=pathlib.Path(tempfile.mkdtemp(prefix='.capture-',dir=output)); primary=None
    export_ownership_unknown=False
    try:
        dump=stage/'database.dump'
        # A stopped runuser direct child is NOT proof that its export stopped.
        export_ownership_unknown=m['mode'] in ('production','hosted-disposable')
        bounded(launch,dump,m['timeout_seconds'],m['max_bytes'])
        export_ownership_unknown=False
        inventory=[]; total=[0]; seen={}; started=time.monotonic()
        def archive_node(tar,parent_fd,name,arc,expected=None):
            require(time.monotonic()-started<m['timeout_seconds'],'archive timeout')
            flags=os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_NOATIME
            if parent_fd is None:
                anchor=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
                try:
                    parts=pathlib.Path(name).parts[1:]
                    for component in parts[:-1]:
                        nextfd=os.open(component,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=anchor)
                        os.close(anchor); anchor=nextfd
                    fd=os.open(parts[-1],flags,dir_fd=anchor)
                finally: os.close(anchor)
            else: fd=os.open(name,flags,dir_fd=parent_fd)
            try:
                st=os.fstat(fd)
                require(stat.S_ISDIR(st.st_mode) or stat.S_ISREG(st.st_mode),'symlink/special object rejected')
                if expected: require([st.st_dev,st.st_ino,st.st_uid]==[expected[k] for k in ('dev','ino','uid')],'root identity changed')
                total[0]+=st.st_size; require(total[0]<=m['max_bytes'],'archive byte limit')
                xattrs={k:base64.b64encode(os.getxattr(fd,k)).decode() for k in os.listxattr(fd)}
                meta={'name':arc,'mode':stat.S_IMODE(st.st_mode),'uid':st.st_uid,'gid':st.st_gid,'mtime_ns':st.st_mtime_ns,'atime_ns':st.st_atime_ns,'dev':st.st_dev,'ino':st.st_ino,'nlink':st.st_nlink,'xattrs_base64':xattrs}
                ti=tarfile.TarInfo(arc); ti.mode=meta['mode']; ti.uid=st.st_uid; ti.gid=st.st_gid; ti.mtime=st.st_mtime
                ti.pax_headers={'mtime':str(st.st_mtime_ns//1000000000)+'.'+str(st.st_mtime_ns%1000000000).zfill(9)}
                if stat.S_ISDIR(st.st_mode):
                    ti.type=tarfile.DIRTYPE; tar.addfile(ti)
                    names=sorted(os.listdir(fd))
                    for child in names: archive_node(tar,fd,child,arc+'/'+child)
                    require(names==sorted(os.listdir(fd)),'directory changed')
                else:
                    key=(st.st_dev,st.st_ino)
                    if key in seen:
                        ti.type=tarfile.LNKTYPE; ti.linkname=seen[key]; tar.addfile(ti); meta['hardlink']=seen[key]
                    else:
                        seen[key]=arc; ti.size=st.st_size
                        with os.fdopen(os.dup(fd),'rb') as src:
                            h=hashlib.sha256()
                            class Reader:
                                def read(self,n):
                                    writer.check(); b=src.read(n); writer.check(); h.update(b); return b
                            tar.addfile(ti,Reader()); meta['sha256']=h.hexdigest()
                after=os.fstat(fd)
                require((st.st_size,st.st_mtime_ns,st.st_ctime_ns)==(after.st_size,after.st_mtime_ns,after.st_ctime_ns),'source changed')
                inventory.append(meta)
            finally: os.close(fd)
        with open(stage/'payload.tar','xb',buffering=0) as raw:
            writer=ArchiveWriter(raw,m['max_bytes'],started+m['timeout_seconds'])
            with tarfile.open(fileobj=writer,mode='w',format=tarfile.PAX_FORMAT) as tar:
                for i,r in enumerate(m['roots']): archive_node(tar,None,r['path'],f'roots/{i}',r)
                tar.add(dump,arcname='database.dump',recursive=False)
                payload={'schema':'capture-inventory-v1','simulated_db':m['mode']=='fixture','restore_proof':False,'manifest':m,'files':inventory,'db_sha256':hashfile(dump,max_bytes=m['max_bytes'],seconds=max(0,writer.deadline-time.monotonic()))}
                with open(stage/'inventory.json','xb',buffering=0) as inv:
                    iw=ArchiveWriter(inv,m['max_bytes']-writer.count,writer.deadline)
                    for part in json.JSONEncoder(sort_keys=True).iterencode(payload): iw.write(part.encode())
                    inv.flush(); os.fsync(inv.fileno())
                tar.add(stage/'inventory.json',arcname='inventory.json',recursive=False)
        os.chmod(stage/'payload.tar',0o600)
        require(os.path.getsize(stage/'payload.tar')<=m['max_bytes'],'tar exceeds bound')
        bounded(['/usr/bin/openssl','cms','-encrypt','-binary','-aes-256-cbc','-stream','-outform','DER','-in',str(stage/'payload.tar'),str(recipient)],stage/'payload.cms',m['timeout_seconds'],m['max_bytes'])
        if m['mode']=='production': require(time.time()<min(auth['expires_epoch'],fence['expires_epoch']),'receipt expired during capture')
        receipt={'schema':'encrypted-local-capture-v1','manifest_sha256':mh,'ciphertext_sha256':hashfile(stage/'payload.cms'),'ciphertext_bytes':os.path.getsize(stage/'payload.cms'),'simulated_db':m['mode']=='fixture','restore_proof':False,'offhost_custody':False,'cipher':'OpenSSL CMS AES-256-CBC recipient certificate; SHA256 integrity bound externally'}
        if m['mode']=='hosted-disposable':
            receipt.update(test_only=True,production_authority=False,identity=m['identity'])
        # A hard link creates final ciphertext without overwrite. All metadata/completion follows fsync.
        os.link(stage/'payload.cms',output/'payload.cms'); fsync_dir(output)
        durable(output/'capture-manifest.json',json.dumps(receipt,sort_keys=True).encode()); fsync_dir(output)
        shutil.rmtree(stage)
        durable(output/'COMPLETE',b'LOCAL_ENCRYPTED_CAPTURE_ONLY\n'); fsync_dir(output)
        print(json.dumps(receipt)); return 0
    except BaseException as e:
        primary=e
        raise
    finally:
        if stage.exists() and (export_ownership_unknown or getattr(primary,'ownership_unknown',False)):
            print('OWNERSHIP_UNKNOWN: plaintext retained at '+str(stage)+'; no COMPLETE; independent writer-stop proof required',file=sys.stderr)
        elif stage.exists():
            try: shutil.rmtree(stage)
            except Exception as e:
                print('CLEANUP_FAILED (primary preserved): '+str(e),file=sys.stderr)
                if primary is None: raise
if __name__=='__main__':
    os.umask(0o077)
    try: sys.exit(main())
    except Exception as e: print(type(e).__name__+': '+str(e),file=sys.stderr); sys.exit(2)
