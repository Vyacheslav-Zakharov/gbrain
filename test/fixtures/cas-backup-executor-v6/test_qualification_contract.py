"""Offline contract tests only; not PostgreSQL execution evidence."""
import pathlib, unittest
import qualify, capture
from unittest.mock import patch

class QualificationContract(unittest.TestCase):
 def test_second_cluster_globals_before_database(self):
  source=pathlib.Path(qualify.__file__).read_text()
  self.assertIn("'restore-pgdata'",source,'restore must use a second isolated cluster')
  self.assertIn("'--username=postgres'",source)
  self.assertIn("'--port=55440'",source)
  self.assertLess(source.index("'--file='+str(base/'globals-adapted.sql')"),source.index("pg('pg_restore'"))
  for token in ['globals_sha256','pg_auth_members','pg_get_userbyid','has_table_privilege','has_schema_privilege','roles_membership_ownership_grants_equal','restore_cluster!=cluster']:
   self.assertIn(token,source)
 def test_subprocess_errors_redact_sql(self):
  import subprocess
  with patch.object(qualify.subprocess,'run',side_effect=subprocess.CalledProcessError(1,['psql','SECRET_SQL'],stderr='VERIFIER')):
   with self.assertRaises(capture.Refusal) as e:qualify.run(['psql','SECRET_SQL'])
  self.assertNotIn('SECRET_SQL',str(e.exception));self.assertNotIn('VERIFIER',str(e.exception))
 def test_local_main_stops_before_any_process(self):
  with patch.dict(qualify.os.environ,{'GITHUB_ACTIONS':'false'}),patch.object(qualify.subprocess,'run') as run:
   with self.assertRaises(capture.Refusal):qualify.main()
   run.assert_not_called()
