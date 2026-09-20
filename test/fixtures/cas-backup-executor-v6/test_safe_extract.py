import io, os, pathlib, tarfile, tempfile, unittest
import capture

class ExtractTests(unittest.TestCase):
 def archive(self, entries):
  stream=io.BytesIO()
  with tarfile.open(fileobj=stream,mode='w') as t:
   for name,kind,value in entries:
    m=tarfile.TarInfo(name); m.type=kind
    if kind==tarfile.REGTYPE: m.size=len(value); t.addfile(m,io.BytesIO(value))
    else: m.linkname=value; t.addfile(m)
  stream.seek(0); return tarfile.open(fileobj=stream)
 def test_isolated_links_and_no_traversal(self):
  self.assertTrue(callable(getattr(capture,'extract_isolated',None)),'safe isolated extraction missing')
  with tempfile.TemporaryDirectory(dir=pathlib.Path(__file__).parent) as tmp:
   base=pathlib.Path(tmp); outside=base/'outside'; outside.mkdir(); (outside/'keep').write_bytes(b'unchanged')
   with self.archive([('data',tarfile.REGTYPE,b'hello'),('bin/tool',tarfile.SYMTYPE,'../data'),('absolute',tarfile.SYMTYPE,str(outside)),('dangling',tarfile.SYMTYPE,'missing'),('hard',tarfile.LNKTYPE,'data')]) as t:
    capture.extract_isolated(t,base/'good')
   self.assertEqual(os.readlink(base/'good/bin/tool'),'../data'); self.assertEqual(os.readlink(base/'good/absolute'),str(outside))
   self.assertTrue((base/'good/dangling').is_symlink()); self.assertEqual((base/'good/data').read_bytes(),b'hello')
   self.assertEqual((base/'good/hard').stat().st_ino,(base/'good/data').stat().st_ino)
   for i,entries in enumerate([
    [('pivot',tarfile.SYMTYPE,str(outside)),('pivot/pwn',tarfile.REGTYPE,b'bad')],
    [('pivot/pwn',tarfile.REGTYPE,b'bad'),('pivot',tarfile.SYMTYPE,str(outside))],
    [('../outside/pwn',tarfile.REGTYPE,b'bad')],
    [('/escape',tarfile.REGTYPE,b'bad')],
    [('s',tarfile.SYMTYPE,str(outside/'keep')),('h',tarfile.LNKTYPE,'s')],
    [('x',tarfile.REGTYPE,b'1'),('x',tarfile.SYMTYPE,str(outside))],
   ]):
    with self.subTest(i=i),self.archive(entries) as t:
     with self.assertRaises(capture.Refusal): capture.extract_isolated(t,base/f'bad{i}')
     self.assertFalse((base/f'bad{i}').exists())
   self.assertEqual(list(outside.iterdir()),[outside/'keep']); self.assertEqual((outside/'keep').read_bytes(),b'unchanged')
  print('PROOF: real tar isolated extraction; links preserved; link-ancestor/order/hardlink/traversal attacks refused before writes')
if __name__=='__main__': unittest.main(verbosity=2)
