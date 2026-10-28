#!/usr/bin/env bash
# bin-verify.sh — verify the estate bin manifest.
# Usage: bin-verify.sh [manifest.yaml]
# Exits 0 when everything checks out, 1 with a clear FAIL list otherwise.
# Lines: 'ok   <id>' / 'FAIL <id>: <reason>' / 'WARN <id>: <reason>'.
set -uo pipefail
# The manifest lives beside this script (pens/barn/estate-ops/bin). The old
# estate/bin/ mirror was retired 2026-10-27 — it pointed at the pre-reorg
# layout and was the source of 282 phantom warnings.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOV="${SOV:-/home/toxic}"
MANIFEST="${1:-$HERE/manifest.yaml}"
exec python3 - "$MANIFEST" "$SOV" <<'PYEOF'
import hashlib, os, shutil, subprocess, sys

MANIFEST, SOV = sys.argv[1], sys.argv[2]
fails, warns, oks = [], [], []

# Paths under the managed dirs that are intentionally NOT manifest entries:
# pd-alias/ is a tool's own data dir (base64-named alias payloads) and
# frida-compile is a standalone script the generator excludes from the scan.
SKIP_UNLISTED = {'pd-alias', 'frida-compile'}

def _strip_comment(line):
    out, q = [], None
    for c in line:
        if q:
            out.append(c)
            if c == q:
                q = None
        elif c in '"\'':
            q = c
            out.append(c)
        elif c == '#':
            break
        else:
            out.append(c)
    return ''.join(out).rstrip()

def _scalar(s):
    s = s.strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in '"\'':
        return s[1:-1]
    if s.startswith('[') and s.endswith(']'):
        inner = s[1:-1].strip()
        if not inner:
            return []
        parts, cur, q = [], '', None
        for c in inner:
            if q:
                cur += c
                if c == q:
                    q = None
            elif c in '"\'':
                q = c
                cur += c
            elif c == ',':
                parts.append(_scalar(cur))
                cur = ''
            else:
                cur += c
        parts.append(_scalar(cur))
        return [p for p in parts if p != '']
    if s in ('true', 'True'):
        return True
    if s in ('false', 'False'):
        return False
    if s in ('null', 'None', '~', ''):
        return None
    try:
        return int(s)
    except ValueError:
        return s

def parse_manifest(text):
    # Restricted YAML subset: top-level map; stale_paths/dirs = scalar lists;
    # bins/archived = lists of maps with scalar or inline-list values.
    root, cur_list, cur_item = {}, None, None
    for raw in text.splitlines():
        line = _strip_comment(raw)
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip(' '))
        s = line.strip()
        if indent == 0:
            if ':' not in s:
                raise ValueError('bad top-level line: %r' % raw)
            k, v = s.split(':', 1)
            k, v = k.strip(), v.strip()
            if v == '':
                if k not in ('stale_paths', 'dirs', 'bins', 'archived', 'links'):
                    raise ValueError('unsupported block key: %r' % k)
                cur_list = []
                root[k] = cur_list
                cur_item = None
            else:
                root[k] = _scalar(v)
                cur_list = None
                cur_item = None
        elif s.startswith('- '):
            if cur_list is None:
                raise ValueError('list item outside list: %r' % raw)
            item = s[2:].strip()
            if ':' in item and not item.startswith(('"', "'", '[')):
                k, v = item.split(':', 1)
                k, v = k.strip(), v.strip()
                d = {}
                if v != '':
                    d[k] = _scalar(v)
                cur_list.append(d)
                cur_item = d
            else:
                cur_list.append(_scalar(item))
                cur_item = None
        else:
            if cur_item is None or ':' not in s:
                raise ValueError('bad line: %r' % raw)
            k, v = s.split(':', 1)
            cur_item[k.strip()] = _scalar(v.strip())
    return root

def md5(p):
    h = hashlib.md5()
    with open(p, 'rb') as f:
        for chunk in iter(lambda: f.read(65536), b''):
            h.update(chunk)
    return h.hexdigest()

def is_binary(p):
    with open(p, 'rb') as f:
        return b'\x00' in f.read(8192)

def first_line(p):
    with open(p, 'rb') as f:
        return f.readline().decode('utf-8', 'replace').rstrip('\r\n')

def interp_ok(shebang):
    if shebang.startswith('#!/usr/bin/env '):
        prog = shebang[len('#!/usr/bin/env '):].split()[0]
        return (shutil.which(prog) is not None, 'interpreter %s' % prog)
    if shebang.startswith('#!'):
        prog = shebang[2:].split()[0]
        return (os.access(prog, os.X_OK), 'interpreter %s' % prog)
    return (False, 'unparseable shebang')

SYNTAX = {
    'bash': ['bash', '-n'],
    'sh': ['sh', '-n'],
    'python': [sys.executable, '-m', 'py_compile'],
}

def run_cmd(argv, timeout, env=None):
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, env=env)
        return p.returncode, (p.stdout or '') + (p.stderr or ''), False
    except subprocess.TimeoutExpired as e:
        out = ''
        for stream in (e.stdout, e.stderr):
            if stream:
                out += stream.decode('utf-8', 'replace') if isinstance(stream, bytes) else stream
        return None, out, True
    except OSError as e:
        return None, 'exec failed: %s' % e, False

def check_run(eid, path, e):
    argv = [path] + (e.get('run') or [])
    timeout = e.get('timeout', 15)
    rc, out, timed_out = run_cmd(argv, timeout)
    wants = ([e['expect']] if e.get('expect') else []) + (e.get('expect_any') or [])
    matched = [w for w in wants if w and w in out]
    if e.get('expect_in_output'):
        if matched:
            return True, 'output matched %r (rc=%s, timed_out=%s)' % (matched[0], rc, timed_out)
        return False, 'expected output not seen (rc=%s, timed_out=%s); tail: %r' % (rc, timed_out, out[-200:])
    if timed_out:
        return False, 'timed out after %ss' % timeout
    if rc != 0:
        return False, 'exit %s; tail: %r' % (rc, out[-200:])
    if wants and not matched:
        return False, 'rc=0 but expected %r not in output; tail: %r' % (wants, out[-200:])
    return True, 'rc=0' + (', matched %r' % matched[0] if matched else '')

def main():
    try:
        with open(MANIFEST, encoding='utf-8') as f:
            m = parse_manifest(f.read())
    except (OSError, ValueError) as e:
        print('FAIL manifest: cannot parse %s: %s' % (MANIFEST, e))
        return 1
    stale = m.get('stale_paths', []) or []
    seen = set()
    # links: pinned product symlinks (AGENTS.md Layout). Target must exist and
    # the link (if present) must resolve to it. $HOME-expanded manually.
    home = os.path.expanduser('~')
    for link in m.get('links', []) or []:
        name = link.get('name', '')
        target = link.get('target', '')
        if not name or not target:
            fails.append('links entry incomplete: %r' % (link,))
            continue
        if not os.path.isfile(target):
            fails.append('links/%s: missing target %s' % (name, target))
            continue
        if name.startswith('~'):
            full = os.path.join(home, name[2:].lstrip('/'))
        elif name.startswith('/'):
            full = name
        else:
            full = os.path.join(SOV, name)
        seen.add(os.path.normpath(full))
        if not os.path.islink(full):
            fails.append('links/%s: not a symlink (%s exists but does not point at %s)' % (name, full, target))
            continue
        if os.path.realpath(full) != os.path.realpath(target):
            fails.append('links/%s: points at %s, expected %s' % (name, os.path.realpath(full), target))
            continue
        oks.append('links/%s -> %s' % (name, target))
    for e in m.get('bins', []) or []:
        name, d, kind = e['name'], e['dir'], e['kind']
        eid = '%s/%s' % (d, name)
        seen.add(os.path.normpath(os.path.join(d, name)))
        path = os.path.join(d, name) if os.path.isabs(d) else os.path.join(SOV, d, name)
        if kind == 'symlink':
            if os.path.islink(path) and os.path.exists(path):
                oks.append(eid)
            else:
                target = os.readlink(path) if os.path.islink(path) else '?'
                fails.append('%s: broken/missing symlink -> %s' % (eid, target))
            continue
        if not os.path.isfile(path):
            fails.append('%s: missing file %s' % (eid, path))
            continue
        if kind == 'data':
            if e.get('parse') == 'manifest':
                try:
                    with open(path, encoding='utf-8') as f:
                        parse_manifest(f.read())
                    oks.append(eid)
                except ValueError as ex:
                    fails.append('%s: manifest does not parse: %s' % (eid, ex))
            else:
                oks.append(eid)
            continue
        if not os.access(path, os.X_OK):
            fails.append('%s: not executable' % eid)
            continue
        if kind == 'binary':
            if os.path.getsize(path) == 0:
                fails.append('%s: 0-byte binary' % eid)
                continue
            with open(path, 'rb') as f:
                if f.read(4) != b'\x7fELF':
                    fails.append('%s: not an ELF binary' % eid)
                    continue
        else:  # script
            fl = first_line(path)
            if fl != e.get('shebang', ''):
                fails.append('%s: bad shebang %r, want %r' % (eid, fl, e.get('shebang', '')))
                continue
            ok, detail = interp_ok(fl)
            if not ok:
                fails.append('%s: %s missing' % (eid, detail))
                continue
            syn = e.get('syntax')
            if syn and syn in SYNTAX:
                env = None
                if syn == 'python':
                    # keep verifier runs from littering __pycache__ in managed dirs
                    env = dict(os.environ, PYTHONPYCACHEPREFIX='/tmp/bin-verify-pycache')
                rc, out, _ = run_cmd(SYNTAX[syn] + [path], 30, env)
                if rc != 0:
                    fails.append('%s: %s syntax check failed: %r' % (eid, syn, out[-200:]))
                    continue
            if not is_binary(path):
                try:
                    with open(path, encoding='utf-8', errors='replace') as f:
                        text = f.read()
                except OSError:
                    text = ''
                hit = [p for p in stale if p in text]
                if hit:
                    fails.append('%s: stale path reference(s): %s' % (eid, hit))
                    continue
        if e.get('same_as'):
            other = os.path.join(SOV, e['same_as'])
            if not os.path.isfile(other):
                fails.append('%s: same_as target missing: %s' % (eid, other))
                continue
            if md5(path) != md5(other):
                fails.append('%s: diverged from %s (md5 mismatch)' % (eid, e['same_as']))
                continue
        if e.get('run') is not None or e.get('expect') or e.get('expect_any'):
            ok, detail = check_run(eid, path, e)
            if not ok:
                fails.append('%s: run check failed: %s' % (eid, detail))
                continue
            oks.append('%s (%s)' % (eid, detail))
        else:
            oks.append(eid)
    for a in m.get('archived', []) or []:
        dest = os.path.join(SOV, a['to'])
        # `kept: false` = removal already recorded, tombstone deliberately not
        # kept (e.g. archive dir cleaned during a later move). The entry itself
        # is the record; no tombstone is expected.
        if os.path.lexists(dest) or a.get('kept') is False:
            oks.append('archived:%s' % a['name'])
        else:
            fails.append('archived:%s: missing at %s' % (a['name'], a['to']))
    for d in m.get('dirs', []) or []:
        dp = os.path.join(SOV, d)
        if not os.path.isdir(dp):
            fails.append('dir missing: %s' % dp)
            continue
        for root, _ds, files in os.walk(dp):
            for fn in files:
                fp = os.path.join(root, fn)
                rel = os.path.normpath(os.path.relpath(fp, SOV))
                # `seen` holds absolute paths; the walk produces SOV-relative
                # ones. Compare on the same footing so a listed ~/.local/bin
                # link is not also reported as unlisted.
                rel_abs = os.path.normpath(fp)
                # Deliberately-unlisted entries: files the generator excludes
                # from the bin scan (tool data dirs, standalone scripts).
                if any(part in SKIP_UNLISTED for part in rel.split(os.sep)):
                    continue
                if os.path.islink(fp) and not os.path.exists(fp):
                    fails.append('broken symlink: %s -> %s' % (rel, os.readlink(fp)))
                elif rel not in seen and rel_abs not in seen:
                    warns.append('unlisted file in managed dir: %s' % rel)
    for o in sorted(oks):
        print('ok   %s' % o)
    for w in sorted(warns):
        print('WARN %s' % w)
    for f_ in fails:
        print('FAIL %s' % f_)
    print('---- %d ok, %d FAIL, %d warn ----' % (len(oks), len(fails), len(warns)))
    return 1 if fails else 0

sys.exit(main())
PYEOF
