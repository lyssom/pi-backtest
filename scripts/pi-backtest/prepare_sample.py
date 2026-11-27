"""Build an offline, read-only UI sample from a pinned public market archive."""

import csv
import hashlib
import io
import json
from decimal import Decimal
from pathlib import Path
from urllib.request import urlopen
from zipfile import ZipFile

HOUR = 3_600_000
START = 1746057600000  # 2025-05-01 00:00 UTC
END = START + 96 * HOUR
FILE = 'BTCUSDT-1h-2025-05'
URL = f'https://data.binance.vision/data/futures/um/monthly/klines/BTCUSDT/1h/{FILE}.zip'
SHA256 = '2e736b9e792d5ae9d4607d7426e4530020762cb898d580b18d3fb0faf9d2ba8e'
FIXED_NOTIONAL = Decimal(1000)
FEE_RATE = Decimal('0.0005')


def parse_candles(text, start, end):
    bars = []
    for row in csv.reader(io.StringIO(text)):
        if row[0] == 'open_time':
            continue
        time = int(row[0])
        if not start <= time < end:
            continue
        if time != start + len(bars) * HOUR or int(row[6]) != time + HOUR - 1:
            raise ValueError('Expected contiguous closed hourly candles')
        o, h, l, c = map(Decimal, row[1:5])
        if not all(x.is_finite() for x in (o, h, l, c)) or not (0 < l <= min(o, c) <= max(o, c) <= h):
            raise ValueError('Invalid OHLC')
        bars.append(dict(time=time, open=float(o), high=float(h), low=float(l), close=float(c)))
    if start + len(bars) * HOUR != end:
        raise ValueError('Expected contiguous closed hourly candles')
    return bars


def build_report(bars, fast=3, slow=8):
    # Seed both EMAs from the first close. Decide at close; act on the next open.
    fast_ema = slow_ema = Decimal(str(bars[0]['close']))
    fast_k, slow_k = [Decimal(2) / (p + 1) for p in (fast, slow)]
    position = pending = None
    trades, chart = [], []
    gross_total = fees_total = Decimal(0)

    def close_position(fill, reason):
        nonlocal position, gross_total, fees_total
        entry = Decimal(str(position['price']))
        exit_price = Decimal(str(fill['price']))
        gross = FIXED_NOTIONAL / entry * (exit_price - entry)
        fees = (FIXED_NOTIONAL / entry * exit_price + FIXED_NOTIONAL) * FEE_RATE
        gross_total += gross
        fees_total += fees
        trades.append(dict(id=len(trades) + 1, entry=position, exit=fill, exitReason=reason,
                           fees=float(round(fees, 6)), net=float(round(gross - fees, 6))))
        position = None

    for i, bar in enumerate(bars):
        if pending is not None:
            fill = dict(bar=i, price=bar['open'], signalBar=i - 1)
            if pending == 'enter':
                position = fill
            else:
                close_position(fill, 'cross')
            pending = None
        previous = fast_ema - slow_ema
        close = Decimal(str(bar['close']))
        fast_ema += (close - fast_ema) * fast_k
        slow_ema += (close - slow_ema) * slow_k
        current = fast_ema - slow_ema
        if position is None and previous <= 0 < current:
            pending = 'enter'
        elif position is not None and previous >= 0 > current:
            pending = 'exit'
        chart.append({**bar, 'fastEma': float(fast_ema), 'slowEma': float(slow_ema)})
    if position is not None:
        close_position(dict(bar=len(bars) - 1, price=bars[-1]['close'], signalBar=None), 'window_end')

    return dict(version=1, bars=chart, trades=trades, strategy=dict(fast=fast, slow=slow,
                notional=float(FIXED_NOTIONAL), feeBps=float(FEE_RATE * 10_000)),
                summary=dict(closed=len(trades), wins=sum(t['net'] > 0 for t in trades),
                             net=float(round(gross_total - fees_total, 6)), fees=float(round(fees_total, 6))))


def main():
    with urlopen(URL, timeout=20) as response:
        raw = response.read(512 * 1024 + 1)
    if len(raw) > 512 * 1024 or hashlib.sha256(raw).hexdigest() != SHA256:
        raise ValueError('Public archive did not match the pinned SHA-256')
    with ZipFile(io.BytesIO(raw)) as archive:
        bars = parse_candles(archive.read(f'{FILE}.csv').decode('utf-8-sig'), START, END)
    report = build_report(bars)
    out = Path(__file__).resolve().parents[2] / '.pi-backtest' / 'sample.json'
    out.parent.mkdir(exist_ok=True)
    temp = out.with_suffix('.tmp')
    temp.write_text(json.dumps(report, allow_nan=False), encoding='utf-8')
    temp.replace(out)
    print(f'{len(bars)} candles, {report["summary"]["closed"]} closed trades: {out}')


if __name__ == '__main__':
    main()
