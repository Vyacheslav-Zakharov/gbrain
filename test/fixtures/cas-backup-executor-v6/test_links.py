import json, os, pathlib, subprocess, tarfile, unittest
import test_capture
import capture

class LinkTests(test_capture.CaptureTests):
 # Reuse fixture helpers without repeating the inherited suite.
 pass
for _name in list(vars(test_capture.CaptureTests)):
 if _name.startswith('test_'): setattr(LinkTests, _name, None)

def test_runtime_links_cms(self):
 root=self.tmp/'runtime'; (root/'node_modules/.bin').mkdir(parents=True)
 (root/'venv/bin').mkdir(parents=True)
 outside=self.tmp/'outside'; outside.mkdir(); sentinel=b'OUTSIDE_TARGET_BYTES_NEVER_ARCHIVE_9628'
 (outside/'secret').write_bytes(sentinel)
 links={'node_modules/.bin/tool':'../package/bin/tool.js','venv/bin/python':'/usr/bin/python3','dangling':'missing-target','external':str(outside),'external-file':str(outside/'secret')}
 for name,target in links.items(): (root/name).symlink_to(target)
 before={name:(root/name).lstat() for name in links}
 p=self.run_capture(); self.assertEqual(p.returncode,0,p.stderr)
 decrypted=self.tmp/'links.tar'
 subprocess.run(['/usr/bin/openssl','cms','-decrypt','-binary','-inform','DER','-in',str(self.tmp/'out/payload.cms'),'-recip',str(self.cert),'-inkey',str(self.key),'-out',str(decrypted)],check=True,timeout=10)
 self.assertNotIn(sentinel,decrypted.read_bytes())
 idx=next(i for i,r in enumerate(self.m['roots']) if r['category']=='runtime')
 with tarfile.open(decrypted) as t:
  inv={x['name']:x for x in json.load(t.extractfile('inventory.json'))['files']}
  for name,target in links.items():
   arc=f'roots/{idx}/{name}'; member=t.getmember(arc); meta=inv[arc]
   self.assertTrue(member.issym()); self.assertEqual(member.linkname,target); self.assertEqual(member.size,0)
   self.assertEqual(meta['symlink'],target); self.assertNotIn('sha256',meta)
   self.assertEqual(meta['mtime_ns'],before[name].st_mtime_ns)
   self.assertEqual(member.uid,before[name].st_uid); self.assertEqual(member.gid,before[name].st_gid)
  self.assertFalse(any(x.name.startswith(f'roots/{idx}/external/') for x in t))
 with tarfile.open(decrypted) as t:
  capture.extract_isolated(t,self.tmp/'isolated')
 for name,target in links.items():
  self.assertEqual(os.readlink(self.tmp/'isolated'/f'roots/{idx}'/name),target)
 self.assertEqual((outside/'secret').read_bytes(),sentinel)
 print('PROOF: actual CMS link archive + isolated extraction; relative/absolute/dangling/outside; no target bytes')
LinkTests.test_runtime_links_cms=test_runtime_links_cms

if __name__=='__main__': unittest.main(verbosity=2)
