import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from baseline import make_run, record_run, replay_baseline
from prepare_sample import HOUR


class BaselineTest(unittest.TestCase):
    def setUp(self):
        self.bars = [dict(time=i * HOUR, open=100, high=110, low=90, close=close)
                     for i, close in enumerate([100, 110, 90, 100, 110])]

    def test_replay_and_variant_use_the_same_data_but_different_run_ids(self):
        baseline = make_run(self.bars, 3)
        self.assertEqual(replay_baseline(baseline), baseline)
        variant = make_run(self.bars, 4, baseline['runId'])
        self.assertEqual(variant['dataSha256'], baseline['dataSha256'])
        self.assertNotEqual(variant['runId'], baseline['runId'])
        self.assertEqual(variant['parentRunId'], baseline['runId'])
        self.assertEqual(variant['report']['strategy'], {**baseline['report']['strategy'], 'fast': 4})

    def test_identical_rerun_is_idempotent_and_existing_artifact_is_never_overwritten(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / 'baseline.json'
            run = make_run(self.bars, 3)
            self.assertTrue(record_run(path, run))
            original = path.read_bytes()
            self.assertFalse(record_run(path, run))
            with self.assertRaisesRegex(ValueError, 'overwrite'):
                record_run(path, make_run(self.bars, 4))
            self.assertEqual(path.read_bytes(), original)

    def test_replay_rejects_modified_report(self):
        run = json.loads(json.dumps(make_run(self.bars, 3)))
        run['report']['summary']['net'] += 1
        with self.assertRaisesRegex(ValueError, 'replay'):
            replay_baseline(run)


if __name__ == '__main__':
    unittest.main()
