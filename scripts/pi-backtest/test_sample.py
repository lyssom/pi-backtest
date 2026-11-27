import runpy
import unittest
from pathlib import Path

module = runpy.run_path(str(Path(__file__).with_name('prepare_sample.py')))
report = module['build_report']
parse = module['parse_candles']
HOUR = module['HOUR']


def bars(prices):
    return [dict(time=i * HOUR, open=o, high=max(o, c), low=min(o, c), close=c)
            for i, (o, c) in enumerate(prices)]


class SampleTest(unittest.TestCase):
    def test_signals_trade_at_next_open_and_net_matches_fills(self):
        result = report(bars([(100, 100), (100, 110), (120, 90), (95, 95)]), fast=1, slow=2)
        [trade] = result['trades']
        self.assertEqual(trade['entry'], dict(bar=2, price=120, signalBar=1))
        self.assertEqual(trade['exit'], dict(bar=3, price=95, signalBar=2))
        self.assertEqual(trade['exitReason'], 'cross')
        self.assertAlmostEqual(trade['net'], -209.229167, places=6)
        self.assertEqual(result['summary']['net'], trade['net'])
        self.assertEqual(result['summary']['closed'], 1)
        self.assertEqual(result['summary']['wins'], 0)

    def test_last_signal_never_fills_but_open_position_closes_at_window_end(self):
        self.assertEqual(report(bars([(100, 100), (100, 110)]), fast=1, slow=2)['trades'], [])
        [trade] = report(bars([(100, 100), (100, 110), (120, 130)]), fast=1, slow=2)['trades']
        self.assertEqual(trade['exit'], dict(bar=2, price=130, signalBar=None))
        self.assertEqual(trade['exitReason'], 'window_end')

    def test_data_gaps_and_bad_candles_are_rejected(self):
        lines = ['0,10,12,9,10,0,3599999', '7200000,10,12,9,10,0,10799999']
        with self.assertRaisesRegex(ValueError, 'contiguous'):
            parse('\n'.join(lines), 0, 2 * HOUR)
        with self.assertRaisesRegex(ValueError, 'OHLC'):
            parse('0,10,8,9,10,0,3599999', 0, HOUR)


if __name__ == '__main__':
    unittest.main()
