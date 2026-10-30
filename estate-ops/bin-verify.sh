#!/usr/bin/env bash

set -uo pipefail

# Re-scoped for estate reorg Phase 2b
# Default manifest: pens/barn/estate-ops/bin/manifest.yaml
# SOV = home (since bins span ~/.local/bin + pens/)
SOV="${SOV:-/home/toxic}"
# Manifest default: next to this script (portable across product moves), overridable via $1
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="${1:-$SCRIPT_DIR/bin/manifest.yaml}"
exec python3 - "$MANIFEST" "$SOV" <<'PYEOF'
import hashlib, os, shutil, subprocess, sys

MANIFEST, SOV = sys.argv[1], sys.argv[2]
fails, warns, oks = [], [], []

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
            h.update(f)
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
    global fails, warns, oks
    try:
        with open(MANIFEST, encoding='utf-8') as f:
            m = parse_manifest(f.read())
    except (OSError, ValueError) as e:
        print('FAIL manifest: cannot parse %s: %s' % (MANIFEST, e))
        return 1
    stale = m.get('stale_paths', []) or []
    seen = set()

    home = os.path.expanduser('~')

    # --- links section ---
    for link in m.get('links', []) or []:
        name = link.get('name', '')
        target = link.get('target', '')
        if not name or not target:
            fails.append('links entry incomplete: %r' % (link,))
            continue
        # Resolve target if relative
        if not target.startswith('/'):
            target_full = os.path.normpath(os.path.join(home, '.local/bin', target))
        else:
            target_full = target
        if not os.path.isfile(target_full):
            fails.append('links/%s: missing target %s' % (name, target_full))
            continue
        # Check pens_proximity flag
        pens_prox = link.get('pens_proximity')
        if pens_prox is not None:
            is_pens = (
                target_full.startswith(os.path.join(home, 'pens'))
                or target_full.startswith(os.path.join(home, 'sovereign'))
                or os.path.join(home, '.local/share') in target_full
                or os.path.join(home, '.venv') in target_full
            )
            if bool(pens_prox) != is_pens:
                warns.append('links/%s: pens_proximity=%r but target=%s' % (name, pens_prox, target_full))
        # Resolve the symlink and check it points at target
        # Names may be emitted as `~/.local/bin/<name>` (generator contract) —
        # expand the ~, never double-join under .local/bin again.
        if name.startswith('~/'):
            link_path = os.path.join(home, name[2:])
        elif not name.startswith('/'):
            link_path = os.path.join(home, '.local/bin', name)
        else:
            link_path = name
        if not os.path.lexists(link_path):
            fails.append('links/%s: symlink not found at %s' % (name, link_path))
            continue
        if not os.path.islink(link_path):
            fails.append('links/%s: %s exists but is not a symlink' % (name, link_path))
            continue
        link_target = os.path.realpath(link_path)
        if link_target != os.path.realpath(target_full):
            fails.append('links/%s: resolves to %s, manifest says %s' % (name, link_target, target_full))
            continue
        seen.add(os.path.normpath(link_path))
        seen.add(os.path.normpath(os.path.relpath(link_path, SOV)))
        oks.append('links/%s -> %s' % (name, target))

    # --- bins section ---
    for e in m.get('bins', []) or []:
        name = e['name']
        d = e.get('dir', '')
        kind = e.get('kind', 'script')
        eid = '%s/%s' % (d, name) if d else name

        # Support both old 'dir' format and new 'path' format
        if 'path' in e:
            # New format: path relative to HOME
            rel = e['path']
            if rel.startswith('/'):
                path = rel
            else:
                path = os.path.join(home, rel)
        elif d:
            # Old format: dir relative to SOV
            if d.startswith('/'):
                path = os.path.join(d, name)
            else:
                path = os.path.join(SOV, d, name)
        else:
            fails.append('%s: no dir or path specified' % eid)
            continue

        seen.add(os.path.normpath(path))

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
        else:
            # script
            shebang = e.get('shebang', '')
            if shebang:
                fl = first_line(path)
                if fl != shebang:
                    fails.append('%s: bad shebang %r, want %r' % (eid, fl, shebang))
                    continue
                ok, detail = interp_ok(shebang)
                if not ok:
                    fails.append('%s: %s missing' % (eid, detail))
                    continue

            syn = e.get('syntax')
            if syn and syn in SYNTAX:
                env = None
                if syn == 'python':
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

        # Verify pens_proximity flag
        pens_prox = e.get('pens_proximity')
        if pens_prox is not None:
            is_pens = (
                path.startswith(os.path.join(home, 'pens'))
                or path.startswith(os.path.join(home, 'sovereign'))
                or os.path.join(home, '.local/share') in path
                or os.path.join(home, '.venv') in path
            )
            if bool(pens_prox) != is_pens:
                warns.append('bins/%s: pens_proximity=%r but path=%s' % (name, pens_prox, path))

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

    # --- archived ---
    for a in m.get('archived', []) or []:
        dest = os.path.join(SOV, a['to']) if 'to' in a else ''
        if os.path.lexists(dest) or a.get('kept') is False:
            oks.append('archived:%s' % a['name'])
        elif dest:
            fails.append('archived:%s: missing at %s' % (a['name'], dest))
        else:
            oks.append('archived:%s' % a['name'])

    # --- dirs ---
    for d in m.get('dirs', []) or []:
        dp = os.path.join(SOV, d)
        if not os.path.isdir(dp):
            # Allow .local/bin to not exist at SOV level (it's under HOME)
            dp2 = os.path.join(home, d)
            if not os.path.isdir(dp2):
                fails.append('dir missing: %s' % dp)
                continue
            dp = dp2
        for root, _ds, files in os.walk(dp):
            for fn in files:
                fp = os.path.join(root, fn)
                rel = os.path.normpath(os.path.relpath(fp, SOV))
                # Skip known pre-existing broken-symlink dirs (pd-alias = pdtm)
                if '.pdtm' in rel:
                    continue
                if os.path.islink(fp) and not os.path.exists(fp):
                    fails.append('broken symlink: %s -> %s' % (rel, os.readlink(fp)))
                elif rel not in seen:
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
