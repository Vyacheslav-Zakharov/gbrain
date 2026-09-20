"""Offline byte adapter tests, never PostgreSQL evidence."""
import hashlib,pathlib,tempfile,unittest
import qualify

class BootstrapAdapter(unittest.TestCase):
 def test_one_change_separate_copy_and_safe_receipt(self):
  data=b"-- PostgreSQL globals\nCREATE ROLE postgres;\nALTER ROLE postgres WITH SUPERUSER;\nCREATE ROLE cas_member;\nALTER ROLE cas_member PASSWORD 'PRIVATE';\n"
  with tempfile.TemporaryDirectory() as td:
   original=pathlib.Path(td)/'original.sql';adapted=pathlib.Path(td)/'adapted.sql'
   original.write_bytes(data)
   self.assertTrue(callable(getattr(qualify,'adapt_bootstrap_globals',None)), 'missing narrow adapter')
   receipt=qualify.adapt_bootstrap_globals(original,adapted)
   self.assertEqual(original.read_bytes(),data)
   self.assertEqual(adapted.read_bytes(),data.replace(b'CREATE ROLE postgres;',b'',1))
   self.assertEqual(receipt,{'mode':'adapted-bootstrap-restore','change_count':1,'change':'remove-bootstrap-create-role','original_sha256':hashlib.sha256(data).hexdigest(),'adapted_sha256':hashlib.sha256(adapted.read_bytes()).hexdigest()})
   self.assertEqual(adapted.stat().st_mode & 0o777,0o600)

 def test_adversarial_inputs_refused_without_output(self):
  bad=[b'',b'-- CREATE ROLE postgres;\n',b"SELECT 'CREATE ROLE postgres;';",b'SELECT "CREATE ROLE postgres;";',b'/* CREATE ROLE postgres; */',b"ALTER ROLE member PASSWORD 'CREATE ROLE postgres;';",b'CREATE ROLE postgres;\nCREATE ROLE postgres;',b'create role postgres;',b'CREATE ROLE "postgres";',b'CREATE ROLE postgres WITH SUPERUSER;',b'CREATE\nROLE postgres;',b'CREATE ROLE postgres;\ncreate role POSTGRES;',b"CREATE ROLE postgres;\nSELECT 'unterminated",b'CREATE ROLE postgres;\nSELECT $$fake$$;',b'CREATE ROLE postgres;\n\\connect elsewhere',b'CREATE ROLE postgres;\n/* unfinished',b'CREATE ROLE postgres;\x00',b"SET standard_conforming_strings = off;\nCREATE ROLE postgres;",b"CREATE ROLE postgres;\nSELECT E'\\';"]
  with tempfile.TemporaryDirectory() as td:
   original=pathlib.Path(td)/'original';adapted=pathlib.Path(td)/'adapted'
   for data in bad:
    with self.subTest(data=data):
     original.write_bytes(data)
     with self.assertRaisesRegex(qualify.capture.Refusal,'^bootstrap adapter refused$'):qualify.adapt_bootstrap_globals(original,adapted)
     self.assertFalse(adapted.exists());self.assertEqual(original.read_bytes(),data)
 def test_fake_sql_preserved_with_real_statement(self):
  data=b"-- CREATE ROLE postgres;\nCREATE ROLE postgres;\nSELECT 'CREATE ROLE postgres;';\nSELECT \"CREATE ROLE postgres;\";\nALTER ROLE member PASSWORD 'a''CREATE ROLE postgres;';\n"
  with tempfile.TemporaryDirectory() as td:
   a=pathlib.Path(td)/'a';b=pathlib.Path(td)/'b';a.write_bytes(data)
   qualify.adapt_bootstrap_globals(a,b)
   self.assertEqual(b.read_bytes(),data.replace(b'\nCREATE ROLE postgres;',b'\n',1))
 def test_existing_or_same_target_refused(self):
  with tempfile.TemporaryDirectory() as td:
   a=pathlib.Path(td)/'a';b=pathlib.Path(td)/'b';a.write_bytes(b'CREATE ROLE postgres;');b.write_bytes(b'keep')
   for target in (a,b):
    with self.assertRaises(qualify.capture.Refusal):qualify.adapt_bootstrap_globals(a,target)
   self.assertEqual(b.read_bytes(),b'keep')

 def test_restrict_envelope_preserved(self):
  data=b'\\restrict Ab12\nCREATE ROLE postgres;\n\\unrestrict Ab12\n'
  with tempfile.TemporaryDirectory() as td:
   a=pathlib.Path(td)/'a';b=pathlib.Path(td)/'b';a.write_bytes(data)
   qualify.adapt_bootstrap_globals(a,b)
   self.assertEqual(b.read_bytes(),data.replace(b'CREATE ROLE postgres;',b''))
 def test_unsupported_aliases_and_restrict_refused(self):
  bad=[b'CREATE USER postgres;',b'CREATE GROUP postgres;',b'CREATE ROLE U&"postgres";',b'\\restrict A\n',b'\\restrict A\n\\unrestrict B\n',b'\\unrestrict A\n',b'\\restrict A\n\\restrict A\n\\unrestrict A\n',b'\\restrict A;bad\n']
  with tempfile.TemporaryDirectory() as td:
   a=pathlib.Path(td)/'a';b=pathlib.Path(td)/'b'
   for extra in bad:
    with self.subTest(extra=extra):
     a.write_bytes(b'CREATE ROLE postgres;\n'+extra)
     with self.assertRaises(qualify.capture.Refusal):qualify.adapt_bootstrap_globals(a,b)
     self.assertFalse(b.exists())

 def test_ambiguous_lexical_forms_refused(self):
  extras=[b'-- comment\rCREATE ROLE postgres;\n',b'\fCREATE ROLE postgres;',b"SELECT E'plain';",b"SELECT U&'plain';"]
  with tempfile.TemporaryDirectory() as td:
   a=pathlib.Path(td)/'a';b=pathlib.Path(td)/'b'
   for extra in extras:
    with self.subTest(extra=extra):
     a.write_bytes(b'CREATE ROLE postgres;\n'+extra)
     with self.assertRaises(qualify.capture.Refusal):qualify.adapt_bootstrap_globals(a,b)
     self.assertFalse(b.exists())

if __name__=='__main__':unittest.main()
