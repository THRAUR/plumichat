#!/usr/bin/env python3
"""Body-identity check for a mechanical module split.

The point of splitting operations.js is to MOVE code, not to rewrite it. This
extracts every top-level function in a set of files, normalises whitespace, and
hashes the body — so "did anything change on the way across?" becomes a diff of
two lists instead of a 2,500-line review. A function that gained or lost a single
character shows up; a function that merely moved file does not.

  python3 bodies.py before server/operations.js
  python3 bodies.py after  server/operations.js server/ops/*.js
  python3 bodies.py diff
"""
import hashlib
import io
import json
import os
import re
import sys

OUT = os.path.dirname(os.path.abspath(__file__))


def bodies(paths):
    found = {}
    for path in paths:
        src = io.open(path, encoding='utf-8').read()
        for m in re.finditer(
                r'^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(([^)]*)\)\s*\{',
                src, re.M):
            name, args = m.group(1), m.group(2)
            i, depth = m.end(), 1
            while i < len(src) and depth:
                ch = src[i]
                # Good enough for this codebase: no braces inside string or regex
                # literals at top level of a function body would change the count
                # in a way that survives the whitespace normalisation below.
                if ch == '{':
                    depth += 1
                elif ch == '}':
                    depth -= 1
                i += 1
            body = re.sub(r'\s+', ' ', src[m.end():i - 1]).strip()
            argsig = re.sub(r'\s+', ' ', args).strip()
            if name in found:
                print(f'  !! {name} defined twice ({found[name]["file"]} and {path})')
            found[name] = {
                'file': os.path.basename(path),
                'args': argsig,
                'len': len(body),
                'sha': hashlib.sha256(body.encode()).hexdigest()[:12],
            }
    return found


def main():
    mode = sys.argv[1]
    if mode in ('before', 'after'):
        data = bodies(sys.argv[2:])
        with io.open(os.path.join(OUT, f'bodies-{mode}.json'), 'w', encoding='utf-8') as fh:
            json.dump(data, fh, indent=1, sort_keys=True)
        print(f'{mode}: {len(data)} top-level functions across {len(sys.argv) - 2} file(s)')
        return

    a = json.load(io.open(os.path.join(OUT, 'bodies-before.json'), encoding='utf-8'))
    b = json.load(io.open(os.path.join(OUT, 'bodies-after.json'), encoding='utf-8'))
    gone = sorted(set(a) - set(b))
    new = sorted(set(b) - set(a))
    changed = sorted(n for n in set(a) & set(b) if a[n]['sha'] != b[n]['sha'])
    moved = sorted(n for n in set(a) & set(b)
                   if a[n]['sha'] == b[n]['sha'] and a[n]['file'] != b[n]['file'])
    print(f'unchanged & moved : {len(moved)}')
    print(f'unchanged & stayed: {len(set(a) & set(b)) - len(moved) - len(changed)}')
    print(f'DISAPPEARED       : {len(gone)}   {gone if gone else ""}')
    print(f'NEW               : {len(new)}   {new if new else ""}')
    print(f'BODY CHANGED      : {len(changed)}')
    for n in changed:
        print(f'   {n}: {a[n]["len"]} -> {b[n]["len"]} chars  ({a[n]["file"]} -> {b[n]["file"]})')
    ok = not gone and not changed
    print('\nRESULT:', 'clean move' if ok else 'REVIEW THE ABOVE')
    sys.exit(0 if ok else 1)


main()
