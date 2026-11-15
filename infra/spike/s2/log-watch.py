# SPDX-License-Identifier: AGPL-3.0-or-later
"""Spike S2 (THROWAWAY): prints the receive log (JSON lines on stdin) with each UTC time also shown
in this Mac's zone (EDT/EST), one short line per event. Used as:
  ssh -i ~/.ssh/brightwater-lightsail.pem "$BW_HOST" \
    'tail -n +1 -F /opt/brightwater-spike-s2/data/receive.log' | python3 -u infra/spike/s2/log-watch.py
Drop -F for a one-shot read. Non-JSON lines are passed through unchanged."""
import json
import sys
from datetime import datetime


def local(ts: str) -> str:
    return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone().strftime("%b %-d, %-I:%M:%S %p %Z")


for raw in sys.stdin:
    raw = raw.rstrip("\n")
    try:
        e = json.loads(raw)
    except ValueError:
        print(raw)
        continue
    head = f"{e.get('t')} ({local(e['t'])})" if "t" in e else "?"
    ev = e.get("event")
    if ev == "receive":
        print(f"{head} receive key={e['key']} kind={e['kind']} bytes={e['bytes']} {e['result']} "
              f"sameBody={e.get('sameBody')} ua={e.get('ua', '')[:70]}")
    elif ev == "status":
        s = e.get("status", {})
        items = ", ".join(f"{i['kind']}:{i['state']}:{i['key'][:8]}" for i in s.get("items", []))
        opens = "; ".join(f"{o['at']} online={o['online']} controlled={o['controlled']} queued={o['queued']}"
                          for o in s.get("opens", []))
        print(f"{head} status why={s.get('why')} standalone={s.get('standalone')} controlled={s.get('controlled')} "
              f"persisted={s.get('persisted')} usage={s.get('usage')} quota={s.get('quota')} items=[{items}] opens=[{opens}]")
    else:
        print(f"{head} {ev} {json.dumps({k: v for k, v in e.items() if k not in ('t', 'event')})}")
