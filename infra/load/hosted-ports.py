#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""P7-LOAD hosted mode (owner answer f3d84787): the port rules of the hosted server, as hosted-day.sh reads, limits and puts them back.

Every file is Lightsail's own JSON: a "record" is the output of get-instance-port-states (portStates, each with a state field); an
"infos" file is the list put-instance-public-ports takes (--port-infos file://...), the same rules without the state field.
  infos  <record>            the recorded rules as port infos, exactly (the restore puts these back)
  limit  <record> <ipv4>     the recorded rules with 80 and 443 open to <ipv4>/32 only (no IPv6, no alias); every other rule,
                             port 22 among them, exactly as recorded. A record with no port 22 rule is refused.
  guard  <record> <infos>    exit 0 only when <infos> holds the recorded port 22 rules unchanged (the hard guard: no write changes 22)
  same   <record> <record>   exit 0 when 2 records hold the same rules (order and the state field aside)
Never prints an address: a refusal names the port, not its CIDRs.
"""
import ipaddress
import json
import sys

FIELDS = ('fromPort', 'toPort', 'protocol', 'cidrs', 'ipv6Cidrs', 'cidrListAliases')
LIMITED = (80, 443)


def load(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def rules_of(doc):
    rules = doc['portStates'] if isinstance(doc, dict) else doc
    if not isinstance(rules, list):
        raise ValueError('not a list of port rules')
    return [{k: (sorted(r.get(k) or []) if k in ('cidrs', 'ipv6Cidrs', 'cidrListAliases') else r[k]) for k in FIELDS} for r in rules]


def key(rule):
    return json.dumps(rule, sort_keys=True)


def touches(rule, port):
    return rule['fromPort'] <= port <= rule['toPort']


def fail(msg):
    print(f'hosted-ports: {msg}', file=sys.stderr)
    sys.exit(2)


def main(argv):
    if len(argv) < 2:
        fail('usage: infos <record> | limit <record> <ipv4> | guard <record> <infos> | same <record> <record>')
    cmd = argv[0]
    rec = rules_of(load(argv[1]))
    if cmd == 'infos':
        print(json.dumps(rec, indent=1))
    elif cmd == 'limit':
        try:
            ip = ipaddress.IPv4Address(argv[2])
        except (IndexError, ValueError):
            fail('limit needs this Mac\'s IPv4 address')
        if not any(touches(r, 22) for r in rec):
            fail('the record has no port 22 rule; refused (a put would close the login port)')
        out = []
        for r in rec:
            if any(touches(r, p) for p in LIMITED):
                if (r['fromPort'], r['toPort']) not in ((80, 80), (443, 443)):
                    fail(f"rule {r['fromPort']}-{r['toPort']} spans a web port with others; refused")
                continue
            out.append(r)
        for p in LIMITED:
            out.append({'fromPort': p, 'toPort': p, 'protocol': 'tcp', 'cidrs': [f'{ip}/32'], 'ipv6Cidrs': [], 'cidrListAliases': []})
        print(json.dumps(out, indent=1))
    elif cmd == 'guard':
        new = rules_of(load(argv[2]))
        want = sorted(key(r) for r in rec if touches(r, 22))
        got = sorted(key(r) for r in new if touches(r, 22))
        if not want:
            fail('the record has no port 22 rule; refused')
        if want != got:
            fail('refused: the port rules would change port 22')
    elif cmd == 'same':
        other = rules_of(load(argv[2]))
        if sorted(key(r) for r in rec) != sorted(key(r) for r in other):
            ports = sorted({r['fromPort'] for r in rec} ^ {r['fromPort'] for r in other}) or 'their CIDRs'
            fail(f'the port rules differ (ports {ports})')
    else:
        fail(f'unknown command {cmd}')


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except (OSError, KeyError, ValueError, TypeError) as e:
        fail(f'cannot read the port rules: {type(e).__name__}')
