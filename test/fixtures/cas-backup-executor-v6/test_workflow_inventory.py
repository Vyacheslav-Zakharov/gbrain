"""Hosted offline gate must execute every shipped fixture test module."""
import pathlib,re,unittest

class WorkflowInventory(unittest.TestCase):
 def test_all_modules_in_hosted_gate(self):
  here=pathlib.Path(__file__).resolve().parent
  workflow=(here.parents[2]/'.github/workflows/cas-backup-hosted-v1.yml').read_text()
  command=next(line for line in workflow.splitlines() if 'python3 -B -m unittest -v ' in line)
  actual=command.split('unittest -v ',1)[1].split()
  expected=sorted(p.stem for p in here.glob('test_*.py'))
  self.assertEqual(sorted(actual),expected)
  self.assertEqual(len(actual),len(set(actual)))

if __name__=='__main__':unittest.main()
