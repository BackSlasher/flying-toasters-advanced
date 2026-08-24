#!/usr/bin/env python3
"""Run the behavioral invariant suite against the live player page.

Prerequisites: a static server for the repo (default http://localhost:8437)
and a headless Chromium with --remote-debugging-port=9223 (override CDP_PORT).

Usage: python3 tests/run.py [page-url]
Exit code 0 = all invariants hold.
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdpmini import CDP

URL = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8437/web/index.html'
SUITE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'invariants.js')


def main():
    c = CDP()
    c.cmd('Page.enable')
    c.cmd('Page.navigate', url=URL)
    time.sleep(2)
    c.cmd('Page.reload', ignoreCache=True)
    # wait for the saver to finish booting
    for _ in range(30):
        time.sleep(1)
        r = c.cmd('Runtime.evaluate',
                  expression='!!(window.saver && saver.compound)',
                  returnByValue=True)
        if r.get('result', {}).get('value'):
            break
    else:
        print('FATAL: saver never booted at', URL)
        return 2

    js = open(SUITE).read()
    r = c.cmd('Runtime.evaluate', expression=js,
              awaitPromise=True, returnByValue=True, timeout=180000)
    if 'exceptionDetails' in r:
        print('FATAL: suite threw:', json.dumps(r['exceptionDetails'])[:600])
        return 2
    results = r['result']['value']
    fails = 0
    for row in results:
        mark = 'PASS' if row['pass'] else 'FAIL'
        if not row['pass']:
            fails += 1
        print(f'[{mark}] {row["name"]}' + (f'  — {row["info"]}' if row['info'] else ''))
    print(f'\n{len(results) - fails}/{len(results)} invariants hold')
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
