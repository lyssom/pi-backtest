"""Freeze and verify the demo baseline and one controlled variant, offline after initial import."""

import hashlib
import json
import os
from decimal import Decimal
from tempfile import NamedTemporaryFile

from prepare_sample import STORE, build_report, fetch_bars

ENGINE = 'ema-cross-v1'
PRICE_FIELDS = ('open', 'high', 'low', 'close')


def digest(value):
    return hashlib.sha256(json.dumps(value, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def cents(value):
    precise = Decimal(str(value)) * 100
    if precise != int(precise):
        raise ValueError('Unexpected BTCUSDT price precision')
    return int(precise)


def make_run(bars, fast, parent_id=None):
    market = [{k: bar[k] for k in ('time', *PRICE_FIELDS)} for bar in bars]
    data_sha = digest([[bar['time'], *(cents(bar[k]) for k in PRICE_FIELDS)] for bar in market])
    report = build_report(market, fast=fast)
    strategy = report['strategy']
    run_id = digest([ENGINE, data_sha, fast, strategy['slow'], int(strategy['notional']), int(strategy['feeBps'])])
    return dict(engine=ENGINE, dataSha256=data_sha, runId=run_id, parentRunId=parent_id, report=report)


def replay_baseline(baseline):
    rerun = make_run(baseline['report']['bars'], 3)
    if rerun != baseline:
        raise ValueError('B0 did not match its replay; refusing to replace the frozen baseline')
    return rerun


def record_run(path, run):
    """Publish a complete artifact atomically; replays may verify but never replace it."""
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(run, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
    with NamedTemporaryFile(dir=path.parent) as temp:
        temp.write(payload)
        temp.flush()
        try:
            os.link(temp.name, path)
        except FileExistsError:
            if path.read_bytes() != payload:
                raise ValueError(f'Refusing to overwrite {path.name} with a different run') from None
            return False
    return True


def main():
    path = STORE / 'baseline.json'
    try:
        baseline = replay_baseline(json.loads(path.read_bytes()))
    except FileNotFoundError:
        baseline = make_run(fetch_bars(), 3)
    variant = make_run(baseline['report']['bars'], 4, baseline['runId'])
    for name, file, run in [('B0', path, baseline), ('A1', STORE / 'a1.json', variant)]:
        status = 'frozen' if record_run(file, run) else 'verified (unchanged)'
        print(f'{name}: {status} {run["runId"][:12]}, data {run["dataSha256"][:12]}, {run["report"]["summary"]}')


if __name__ == '__main__':
    main()
