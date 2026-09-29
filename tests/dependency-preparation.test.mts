import './_env.mts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { PREPARATION_PYTHON, PREPARATION_PROXY_PYTHON } from '../server/src/dependencies/preparation-python.ts'
import { prepareDependencies } from '../server/src/dependencies/preparation.ts'
import { requirementSourceUnsupported, unsupportedRequirementLine } from '../shared/dependencies.ts'

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

/*
 * Good pip, but nothing the isolated resolver can reach: each must be named
 * unsupported, not "could not be parsed". Students met the vague one with the
 * first four today.
 */
const UNSUPPORTED = [
  'git+https://github.com/tinygrad/tinygrad.git', 'file:///home/student/pkg-1.0-py3-none-any.whl',
  `numpy==1.26.4 --hash=sha256:${'a'.repeat(64)}`, 'torch --index-url https://download.pytorch.org/whl/cpu',
  'torch==2.3.0 --extra-index-url https://download.pytorch.org/whl/cpu', 'https://example.com/pkg-1.0.tar.gz',
  'git+ssh://git@github.com/user/repo.git#egg=pkg', 'hg+https://hg.example.com/repo', 'FILE:pkg.zip',
  'git@github.com:user/repo.git', 'foo @ https://pypi.org/a.whl', 'foo@git+https://evil.test/a',
  '--index-url https://evil.test', '-r other.txt', '-e .', 'foo --no-deps', 'foo -C key=value',
  './foo', '../lib', '/tmp/a', '~/pkg', 'packages/mylib', 'C:\\pkgs\\x.whl', 'numpy==1.26.4 \\',
  'pkg-1.0-py3-none-any.whl', 'pkg-1.0.tar.gz', 'pkg-1.0-py3-none-any.whl[extra]',
]
// Plain PyPI requirements, a slash or a dash inside a quoted marker value included.
const PLAIN = [
  'numpy', 'numpy==1.26.4', 'scikit-learn>=1.5,<2', 'Requests[security]>=2; python_version >= "3.8"',
  "pkg ; sys_platform == 'linux'", 'torch==2.3.0+cpu', 'pkg ; platform_machine == "arm64/v8"',
  'pkg ; implementation_name == "-x"', 'xgboost-cpu', 'zope.interface', 'pkg (>=1.0)', 'numpy!=1.0.*', 'pkg===1.0',
]
// Genuinely malformed names and specifiers keep the parse error.
const MALFORMED = ['foo===bad version', 'numpy=1.0', 'numpy==', 'num py', 'numpy>=1.0 <2', 'numpy:1.0', 'пакет', 'numpy[']

test('requirements name URLs, paths and pip options as unsupported, keep parse errors for malformed lines, with line numbers', () => {
  python(PREPARATION_PYTHON, `
for value in ${JSON.stringify(UNSUPPORTED)}:
    try: parse_requirements('# comment\\n' + value, [])
    except PreparationFailure as error: assert (error.code, error.line) == ('unsupported_source', 2), (value, error.code, error.line)
    else: raise AssertionError(value)
for value in ${JSON.stringify(MALFORMED)}:
    try: parse_requirements('# comment\\n' + value, [])
    except PreparationFailure as error: assert (error.code, error.line) == ('invalid_requirement', 2), (value, error.code, error.line)
    else: raise AssertionError(value)
assert len(parse_requirements('\\n'.join(${JSON.stringify(PLAIN)}), [])) == ${PLAIN.length}
`)
})

test('the server asks the preparation program\'s question before a preparation is spent', () => {
  for (const value of UNSUPPORTED) assert.equal(requirementSourceUnsupported(value), true, value)
  for (const value of [...PLAIN, ...MALFORMED]) assert.equal(requirementSourceUnsupported(value), false, value)
  // Numbered as the program numbers them: every line, blank and comment ones too.
  assert.equal(unsupportedRequirementLine('# models\n\nnumpy\ntorch --index-url https://download.pytorch.org/whl/cpu\ngit+https://x/y'), 4)
  assert.equal(unsupportedRequirementLine('numpy\r\n# git+https://x/y\r\nscikit-learn'), null, 'a comment is not a request')
  assert.equal(unsupportedRequirementLine(PLAIN.join('\n')), null)
})

test('conflicting base version rejected but inactive marker is allowed', () => {
  python(PREPARATION_PYTHON, `
try: parse_requirements('numpy<2', [{'name':'numpy','version':'2.0'}])
except PreparationFailure as error: assert error.code == 'base_conflict'
else: raise AssertionError('base changed')
assert parse_requirements('numpy<2; python_version < "1.0"', [{'name':'numpy','version':'2.0'}])
`)
})

test('a version pinned against the base names the package and the version the base has', () => {
  python(PREPARATION_PYTHON, `
try: parse_requirements('pandas\\nnumpy==1.19.5', [{'name':'NumPy','version':'2.4.6'}])
except PreparationFailure as error:
    assert (error.code, error.line) == ('base_conflict', 2), (error.code, error.line)
    assert error.params == {'package': 'numpy', 'baseVersion': '2.4.6'}, error.params
else: raise AssertionError('base changed')
try: plan_wheels({'install': [{'metadata': {'name': 'NumPy', 'version': '1.26.4'}, 'download_info': {'url': 'https://files.pythonhosted.org/packages/numpy-1.26.4-py3-none-any.whl'}}]}, {'numpy': '2.4.6'})
except PreparationFailure as error: assert (error.code, error.params) == ('base_conflict', {'package': 'numpy', 'baseVersion': '2.4.6'}), (error.code, error.params)
else: raise AssertionError('a plan replaced a base package')
`)
})

test("pip's conflict explanation names the base version, or who requires which version", () => {
  python(PREPARATION_PYTHON, `
base = {'numpy': '2.4.6'}
explained = '''ERROR: Cannot install gensim==4.3.2 because these package versions have conflicting dependencies.

The conflict is caused by:
    gensim 4.3.2 depends on numpy<2.0 and >=1.18.5
    The user requested (constraint) numpy==2.4.6

To fix this you could try to:
1. loosen the range of package versions you've specified
2. remove package versions to allow pip attempt to solve the dependency conflict

ERROR: ResolutionImpossible: for help visit https://pip.pypa.io/en/latest/topics/dependency-resolution/#dealing-with-dependency-conflicts
'''
expected = {'package': 'numpy', 'baseVersion': '2.4.6', 'requirement': 'numpy<2.0,>=1.18.5', 'requiredBy': 'gensim', 'requiredByVersion': '4.3.2'}
assert conflict_params(explained, base) == expected, conflict_params(explained, base)
try: pip_failed(explained, 'resolution_failed', base)
except PreparationFailure as error: assert (error.code, error.params) == ('dependency_conflict', expected), (error.code, error.params)
else: raise AssertionError('conflict not reported')
inside = '''The conflict is caused by:
    The user requested shared>=3
    Alpha_Pkg[extra] 1.0 depends on shared<2
    evil 1.0 depends on <script>alert(1)</script>

To fix this you could try to:'''
assert conflict_params(inside, base) == {'package': 'shared', 'causes': [{'by': None, 'requirement': 'shared>=3'}, {'by': 'alpha-pkg 1.0', 'requirement': 'shared<2'}]}, conflict_params(inside, base)
assert conflict_params('ERROR: ResolutionImpossible', base) is None
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

// Wheels and a PyPI stand-in for the downloader: bytes by URL, sizes declared like files.pythonhosted.org does.
const FIXTURES = `
import io, tempfile
def build(directory, name, payload, compress=False):
    file = pathlib.Path(directory) / (name + '-1.0-py3-none-any.whl')
    with zipfile.ZipFile(file, 'w', zipfile.ZIP_DEFLATED if compress else zipfile.ZIP_STORED) as archive:
        archive.writestr(name + '-1.0.dist-info/METADATA', 'Metadata-Version: 2.1\\nName: ' + name + '\\nVersion: 1.0\\n')
        archive.writestr(name + '/payload.bin', b'x' * payload)
    body = file.read_bytes()
    return (name, '1.0', 'https://files.pythonhosted.org/packages/' + file.name, file.name, hashlib.sha256(body).hexdigest()), body
class Response:
    def __init__(self, body, readable):
        self.status, self.url, self.stream, self.readable = 200, 'https://files.pythonhosted.org/packages/fixture.whl', io.BytesIO(body), readable
        self.headers = {'Content-Length': str(len(body))}
    def read(self, size):
        assert self.readable, 'the body of a wheel that cannot fit was read'
        return self.stream.read(size)
    def __enter__(self): return self
    def __exit__(self, *args): return False
class Opener:
    def __init__(self, bodies, readable=True): self.bodies, self.readable, self.opened = bodies, readable, []
    def open(self, url, timeout=None):
        self.opened.append(url)
        return Response(self.bodies[url], self.readable)
`

test('an unpacked set over its limit says what it takes and names the heaviest packages', () => {
  python(PREPARATION_PYTHON + FIXTURES, `
with tempfile.TemporaryDirectory() as source, tempfile.TemporaryDirectory() as target:
    WHEELS = pathlib.Path(target)
    nccl, nccl_body = build(source, 'nccl', 3300, True)
    xgboost, xgboost_body = build(source, 'xgboost', 3000, True)
    try: download_wheels([nccl, xgboost], {}, {'maxDownloadBytes': 10 ** 6, 'maxInstalledBytes': 5000}, Opener({nccl[2]: nccl_body, xgboost[2]: xgboost_body}))
    except PreparationFailure as error:
        assert error.code == 'installed_limit', error.code
        params = error.params
        assert (params['limitBytes'], params['partial']) == (5000, False), params
        assert [item['name'] for item in params['heaviest']] == ['nccl', 'xgboost'], params
        assert params['heaviest'][1]['bytes'] > 3000, 'the whole wheel is measured, not the point where counting stopped'
        assert params['bytes'] == sum(item['bytes'] for item in params['heaviest']), params
    else: raise AssertionError('an oversized set was accepted')
`)
})

test('a wheel whose declared size cannot fit fails before its bytes are read', () => {
  python(PREPARATION_PYTHON + FIXTURES, `
for rest_known in (False, True):
    with tempfile.TemporaryDirectory() as source, tempfile.TemporaryDirectory() as target:
        WHEELS = pathlib.Path(target)
        torch, torch_body = build(source, 'torch', 5000)
        sympy, sympy_body = build(source, 'sympy', 400)
        known = {sympy[3]: len(sympy_body)} if rest_known else {}
        try: download_wheels([torch, sympy], known, {'maxDownloadBytes': 1000, 'maxInstalledBytes': 10 ** 6}, Opener({torch[2]: torch_body, sympy[2]: sympy_body}, readable=False))
        except PreparationFailure as error:
            assert error.code == 'download_limit', error.code
            assert error.params['heaviest'][0] == {'name': 'torch', 'bytes': len(torch_body)}, error.params
            # Unknown packages left in the plan make the total a floor.
            assert error.params['partial'] is not rest_known, error.params
            assert error.params['bytes'] == len(torch_body) + (len(sympy_body) if rest_known else 0), error.params
        else: raise AssertionError('an oversized wheel was accepted')
`)
})

test("pip's logged sizes fail a plan over the limit before the wheels come a second time", () => {
  python(PREPARATION_PYTHON + FIXTURES, `
with tempfile.TemporaryDirectory() as source, tempfile.TemporaryDirectory() as target:
    WHEELS = pathlib.Path(target)
    alpha, _ = build(source, 'alpha', 10)
    beta, _ = build(source, 'beta', 10)
    opener = Opener({})
    try: download_wheels([alpha, beta], {alpha[3]: 600000, beta[3]: 700000}, {'maxDownloadBytes': 1000000, 'maxInstalledBytes': 10 ** 6}, opener)
    except PreparationFailure as error:
        assert (error.code, error.params) == ('download_limit', {'bytes': 1300000, 'limitBytes': 1000000, 'partial': False, 'heaviest': [{'name': 'beta', 'bytes': 700000}, {'name': 'alpha', 'bytes': 600000}]}), (error.code, error.params)
        assert opener.opened == [], 'a plan over the limit was downloaded again'
    else: raise AssertionError('a plan over the limit was accepted')
`)
})

test('a full private /tmp is a size error with the sizes pip logged, and disk_full only when they fit', () => {
  python(PREPARATION_PYTHON, `
log = '''Collecting torch
  Downloading torch-2.8.0-cp311-cp311-manylinux_2_28_x86_64.whl.metadata (30 kB)
Collecting sympy>=1.13.3 (from torch)
  Downloading sympy-1.14.0-py3-none-any.whl.metadata (12 kB)
Downloading sympy-1.14.0-py3-none-any.whl (6.3 MB)
Downloading torch-2.8.0-cp311-cp311-manylinux_2_28_x86_64.whl (888.1 MB)
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 596.0/888.1 MB 45.1 MB/s eta 0:00:07
ERROR: Could not install packages due to an OSError: [Errno 28] No space left on device
'''
assert wheel_sizes(log) == {'sympy-1.14.0-py3-none-any.whl': 6300000, 'torch-2.8.0-cp311-cp311-manylinux_2_28_x86_64.whl': 888100000}, wheel_sizes(log)
limit = 500 * 1024 * 1024
try: pip_failed(log, 'resolution_failed', {}, lambda output: download_full(output, limit))
except PreparationFailure as error:
    assert (error.code, error.params) == ('download_limit', {'bytes': 894400000, 'limitBytes': limit, 'partial': True, 'heaviest': [{'name': 'torch', 'bytes': 888100000}]}), (error.code, error.params)
else: raise AssertionError('a full /tmp was not reported')
fits = log.replace('(888.1 MB)', '(88.1 MB)')
for on_full in (lambda output: download_full(output, limit), None):
    try: pip_failed(fits, 'resolution_failed', {}, on_full)
    except PreparationFailure as error: assert (error.code, error.params) == ('disk_full', None), (error.code, error.params)
    else: raise AssertionError('a full disk was not reported')
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
