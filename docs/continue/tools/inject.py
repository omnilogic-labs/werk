import re, sys, pathlib
sp = pathlib.Path(sys.argv[1]).parent
tpl = pathlib.Path(sys.argv[1]).read_text()
out = pathlib.Path(sys.argv[2])
def sub(m):
    key = m.group(1).lower().replace('_', '-')
    p = sp / 'img' / (key + '.datauri.txt')
    if not p.exists():
        raise SystemExit('missing data uri: ' + str(p))
    return p.read_text()
res = re.sub(r'\{\{([A-Z0-9_]+)\}\}', sub, tpl)
left = re.findall(r'\{\{[A-Z0-9_]+\}\}', res)
if left: raise SystemExit('unreplaced: %s' % left)
out.write_text(res)
print(out, len(res), 'chars')
