import './_env.mts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { PREPARATION_PYTHON, PREPARATION_PROXY_PYTHON } from '../server/src/dependencies/preparation-python.ts'
import { prepareDependencies } from '../server/src/dependencies/preparation.ts'

function python(source: string, code: string) {
  const result = spawnSync('python3', ['-c', `__name__ = 'test_helper'\n${source}\n${code}`], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout.trim()
}

test('PEP 508 supports extras and markers, canonicalizes names and reuses base versions', () => {
  const result = python(PREPARATION_PYTHON, `
print(json.dumps(parse_requirements('Requests[security]>=2; python_version >= "3.8"\\n# comment\\nnumpy==2.0', [{'name':'NumPy','version':'2.0'}])))
`)
  const value = JSON.parse(result)
  assert.equal(value.length, 2)
  assert.match(value[0], /^requests\[security\]>=2;/)
})

test('requirements reject options, URLs, paths and invalid syntax with line numbers', () => {
  python(PREPARATION_PYTHON, `
for value in ['--index-url https://evil.test','foo @ https://pypi.org/a.whl','git+https://evil.test/a','./foo','/tmp/a','foo --no-deps','foo===bad version']:
    try: parse_requirements('# comment\\n' + value, [])
    except PreparationFailure as error:
        assert error.line == 2, (value, error.line)
        assert error.code in ('invalid_requirement','unsupported_source'), (value, error.code)
    else: raise AssertionError(value)
`)
})

test('conflicting base version rejected but inactive marker is allowed', () => {
  python(PREPARATION_PYTHON, `
try: parse_requirements('numpy<2', [{'name':'numpy','version':'2.0'}])
except PreparationFailure as error: assert error.code == 'base_conflict'
else: raise AssertionError('base changed')
assert parse_requirements('numpy<2; python_version < "1.0"', [{'name':'numpy','version':'2.0'}])
`)
})

test('proxy only admits exact PyPI hostnames on 443 and rejects non-public DNS', () => {
  python(PREPARATION_PROXY_PYTHON, `
for target in ['pypi.org:443','files.pythonhosted.org:443']:
    assert allowed_authority(target)
for target in ['pypi.org:80','PYPI.ORG:443','pypi.org.:443','pypi.org.evil.test:443','127.0.0.1:443','[::1]:443','user@pypi.org:443','files.pythonhosted.org:444','pypi.org:443/path']:
    assert not allowed_authority(target), target
for value in ['127.0.0.1','10.0.0.1','169.254.169.254','192.168.1.1','100.64.0.1','::1','fc00::1','::ffff:127.0.0.1']:
    assert not public_address(value), value
assert public_address('151.101.0.223')
`)
})

test('wheel validation rejects traversal, symlink, identity mismatch and oversized extraction', () => {
  python(PREPARATION_PYTHON, `
import tempfile
with tempfile.TemporaryDirectory() as directory:
    file = pathlib.Path(directory) / 'demo-1.0-py3-none-any.whl'
    for mode in ['traversal','symlink','identity','size','alias']:
        with zipfile.ZipFile(file, 'w') as archive:
            archive.writestr('demo-1.0.dist-info/METADATA', 'Metadata-Version: 2.1\\nName: ' + ('other' if mode == 'identity' else 'demo') + '\\nVersion: 1.0\\n')
            if mode == 'traversal': archive.writestr('../escape.py', 'x')
            if mode == 'symlink':
                info = zipfile.ZipInfo('link'); info.external_attr = (stat.S_IFLNK | 0o777) << 16; archive.writestr(info, '/tmp')
            if mode == 'size': archive.writestr('large', 'a' * 4096)
            if mode == 'alias': archive.writestr('demo-1.0.dist-info/./METADATA', 'Name: other\\nVersion: 1.0')
        try: validate_wheel(file, 'demo', '1.0', None, 1024)
        except PreparationFailure as error: assert error.code in ('invalid_wheel','installed_limit'), error.code
        else: raise AssertionError(mode)
`)
})

test('already cancelled request never starts preparation or touches staging files', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(prepareDependencies({ id: 'cancelled', imageDigest: 'sha256:' + 'a'.repeat(64), requirementsText: 'demo', basePackages: [], workDir: '/must-not-be-written', maxDownloadBytes: 1024, maxInstalledBytes: 1024, signal: controller.signal }), { code: 'cancelled' })
})

test('wheel hashes reject tampering and valid wheels retain canonical identity', () => {
  python(PREPARATION_PYTHON, `
import tempfile
with tempfile.TemporaryDirectory() as directory:
    file = pathlib.Path(directory) / 'demo-1.0-py3-none-any.whl'
    with zipfile.ZipFile(file, 'w') as archive:
        archive.writestr('demo-1.0.dist-info/METADATA', 'Metadata-Version: 2.1\\nName: Demo\\nVersion: 1.0\\n')
    package, expanded = validate_wheel(file, 'demo', '1.0', None, 4096)
    assert package['name'] == 'demo'
    assert len(package['sha256']) == 64
    try: validate_wheel(file, 'demo', '1.0', '0' * 64, 4096)
    except PreparationFailure as error: assert error.code == 'hash_mismatch'
    else: raise AssertionError('bad hash accepted')
`)
})

test('requirements enforce request and line budgets', () => {
  python(PREPARATION_PYTHON, `
for value in ['a' * 8193, '\\n'.join(['demo'] * 33)]:
    try: parse_requirements(value, [])
    except PreparationFailure as error: assert error.code == 'requirements_limit'
    else: raise AssertionError('request exceeded budget')
`)
})

test('proxy rejects allowed hostname when DNS resolves to a private address', () => {
  python(PREPARATION_PROXY_PYTHON, `
listener = socket.socket(); listener.bind(('127.0.0.1', 0)); listener.listen(1); listener.settimeout(0.1)
original = socket.getaddrinfo
socket.getaddrinfo = lambda *args, **kwargs: [(socket.AF_INET, socket.SOCK_STREAM, 6, '', listener.getsockname())]
server = Server(('127.0.0.1', 0), 10000, 10)
thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
try:
    client = socket.socket(); client.settimeout(2); client.connect(server.server_address)
    client.sendall(b'CONNECT pypi.org:443 HTTP/1.1\\r\\nHost: pypi.org:443\\r\\n\\r\\n')
    assert client.recv(4096) == b'', 'private DNS target was accepted'
    try: connection, address = listener.accept()
    except socket.timeout: pass
    else: connection.close(); raise AssertionError('private upstream was contacted')
finally:
    client.close(); listener.close(); server.shutdown(); server.server_close(); socket.getaddrinfo = original
`)
})
