#!/usr/bin/env python3
"""Execute actual shell construction with inert privilege/namespace shims only."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

REPO = Path(__file__).resolve().parent.parent
BUN = shutil.which('bun')

class Tests(unittest.TestCase):
    def wrapper(self, mode):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); (root/'scripts').mkdir(); (root/'bin').mkdir()
            log = root/'calls'
            shim = '''#!/usr/bin/python3
import os,sys,json
from pathlib import Path
name=Path(sys.argv[0]).name
log=Path(__file__).resolve().parent.parent/'calls'
with log.open('a') as f:f.write(json.dumps({'name':name,'argv':sys.argv[1:],'env':dict(os.environ)})+'\\n')
a=sys.argv[1:]
if name=='id': print('1000');sys.exit()
if name in ('ip','socat'):sys.exit()
if name=='sudo':
 keep=a.pop(0).split('=',1)[1].split(',')
 env={k:os.environ[k] for k in keep if k in os.environ};env['PATH']=os.environ['PATH']
 os.execvpe(a[0],a,env)
if name=='unshare':a.pop(0)
if name=='setpriv':
 while a[0].startswith('--'):a.pop(0)
os.execvp(a[0],a)
'''
            for name in ('sudo','unshare','setpriv','ip','socat','id'):
                p=root/'bin'/name;p.write_text(shim);p.chmod(0o755)
            (root/'bin'/'bun').symlink_to(BUN)
            (root/'scripts'/'markdown-projection-engine-supervisor.py').write_text('''import os,sys,json
from pathlib import Path
if sys.argv[1]=='outer':os.execvp(sys.argv[3],sys.argv[3:])
Path(__file__).resolve().parent.parent.joinpath('result').write_text(json.dumps({'env':dict(os.environ),'argv':sys.argv[3:]}))
''')
            env={'PATH':str(root/'bin')+':/usr/bin:/bin','GITHUB_ACTIONS':'true','MARKDOWN_PROJECTION_DISPOSABLE':'CREATE_AND_DROP_DATABASE','MARKDOWN_PROJECTION_EXPECTED_SERVICE_IP':'192.0.2.1','MARKDOWN_PROJECTION_ADMIN_URL':'postgres://postgres@127.0.0.1:5432/postgres','UNAPPROVED_SECRET':'never-forward'}
            if mode is not None:env['MARKDOWN_PROJECTION_WORKER_MODE']=mode
            p=subprocess.run(['/bin/bash',str(REPO/'scripts/markdown-projection-engine-hosted.sh')],cwd=root,env=env,capture_output=True,text=True,timeout=5)
            calls=[json.loads(x) for x in log.read_text().splitlines()] if log.exists() else []
            result=json.loads((root/'result').read_text()) if (root/'result').exists() else None
            return p,calls,result

    def test_mode_rejected_before_external_execution(self):
        for mode in (None,'','ISOLATED','isolated legacy','$(true)'):
            with self.subTest(mode=mode):
                p,calls,result=self.wrapper(mode)
                self.assertNotEqual(p.returncode,0)
                self.assertEqual(calls,[])
                self.assertIsNone(result)

    def test_mode_survives_both_actual_environment_constructors(self):
        for mode in ('isolated','legacy'):
            with self.subTest(mode=mode):
                p,calls,result=self.wrapper(mode)
                self.assertEqual(p.returncode,0,p.stderr)
                self.assertEqual(result['env'].get('MARKDOWN_PROJECTION_WORKER_MODE'),mode)
                sudo=next(c for c in calls if c['name']=='sudo')
                self.assertIn('MARKDOWN_PROJECTION_WORKER_MODE',sudo['argv'][0].split('=',1)[1].split(','))
                self.assertEqual(result['env']['PATH'],'/usr/bin:/bin')
                self.assertNotIn('UNAPPROVED_SECRET',result['env'])
                self.assertTrue(Path(result['argv'][0]).is_absolute())

if __name__=='__main__':unittest.main()
