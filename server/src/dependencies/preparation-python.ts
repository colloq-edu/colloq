/** Embedded trusted helpers: esbuild must carry these into the server bundle. */
export const PREPARATION_PROXY_PYTHON = String.raw`
import ipaddress, selectors, socket, socketserver, sys, threading, time

ALLOWED = {'pypi.org:443', 'files.pythonhosted.org:443'}

def allowed_authority(authority):
    return authority in ALLOWED

def public_address(value):
    address = ipaddress.ip_address(value)
    return address.is_global and not address.is_multicast and not address.is_reserved and not address.is_unspecified

class Proxy(socketserver.BaseRequestHandler):
    def handle(self):
        upstream = None
        try:
            self.request.settimeout(15)
            header = b''
            while b'\r\n\r\n' not in header:
                chunk = self.request.recv(1)
                if not chunk: return
                header += chunk
                if len(header) > 8192: return
            method, authority, version = header.split(b'\r\n', 1)[0].decode('ascii').split(' ')
            if method != 'CONNECT' or version not in ('HTTP/1.0', 'HTTP/1.1') or not allowed_authority(authority):
                self.request.sendall(b'HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
                return
            host = authority.split(':')[0]
            addresses = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
            if not addresses or any(not public_address(item[4][0]) for item in addresses): return
            # Connect to the validated numeric address; no second DNS resolution.
            for family, kind, protocol, _, address in addresses:
                try:
                    upstream = socket.socket(family, kind, protocol)
                    upstream.settimeout(15)
                    upstream.connect(address)
                    break
                except OSError:
                    upstream.close(); upstream = None
            if upstream is None: return
            self.request.sendall(b'HTTP/1.1 200 Connection Established\r\n\r\n')
            with selectors.DefaultSelector() as selector:
                selector.register(self.request, selectors.EVENT_READ, upstream)
                selector.register(upstream, selectors.EVENT_READ, self.request)
                while time.monotonic() < self.server.deadline:
                    events = selector.select(20)
                    if not events: return
                    for key, _ in events:
                        data = key.fileobj.recv(65536)
                        if not data: return
                        with self.server.budget_lock:
                            self.server.remaining -= len(data)
                            if self.server.remaining < 0: return
                        key.data.sendall(data)
        except (OSError, ValueError, UnicodeError):
            pass
        finally:
            if upstream is not None: upstream.close()

class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
    def __init__(self, address, budget, seconds):
        self.remaining = budget
        self.deadline = time.monotonic() + seconds
        self.budget_lock = threading.Lock()
        self.slots = threading.BoundedSemaphore(16)
        super().__init__(address, Proxy)
    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            request.close(); return
        try: super().process_request(request, address)
        except BaseException:
            self.slots.release(); raise
    def process_request_thread(self, request, address):
        try: super().process_request_thread(request, address)
        finally: self.slots.release()

if __name__ == '__main__':
    with Server(('0.0.0.0', 3128), int(sys.argv[1]), int(sys.argv[2])) as server:
        server.serve_forever(poll_interval=0.25)
`

export const PREPARATION_PYTHON = String.raw`
import email.parser, hashlib, importlib.metadata, json, os, pathlib, re, stat, subprocess, sys, tempfile, urllib.parse, urllib.request, venv, zipfile
try:
    from packaging.requirements import Requirement, InvalidRequirement
    from packaging.utils import canonicalize_name, parse_wheel_filename
    from packaging.version import Version, InvalidVersion
    from packaging.tags import sys_tags
except ImportError:
    from pip._vendor.packaging.requirements import Requirement, InvalidRequirement
    from pip._vendor.packaging.utils import canonicalize_name, parse_wheel_filename
    from pip._vendor.packaging.version import Version, InvalidVersion
    from pip._vendor.packaging.tags import sys_tags

class PreparationFailure(Exception):
    def __init__(self, code, message, line=None):
        self.code, self.message, self.line = code, message, line
        super().__init__(message)

def fail(code, message, line=None):
    raise PreparationFailure(code, message, line)

def emit(value):
    print('__COLLOQ_DEP__' + json.dumps(value, separators=(',', ':')), flush=True)

def parse_requirements(text, base):
    if len(text.encode('utf-8')) > 8192: fail('requirements_limit', 'Requirements exceed 8 KiB.')
    lines = text.splitlines()
    if len(lines) > 32: fail('requirements_limit', 'Requirements exceed 32 lines.')
    inventory = {canonicalize_name(item['name']): Version(item['version']) for item in base}
    normalized = []
    for number, raw in enumerate(lines, 1):
        value = raw.strip()
        if not value or value.startswith('#'): continue
        if value.startswith(('-', '.', '/', '~')) or '\\' in value or '\x00' in value:
            fail('unsupported_source', 'Only PyPI package names, extras, versions and markers are supported.', number)
        try: requirement = Requirement(value)
        except InvalidRequirement: fail('invalid_requirement', 'Invalid PEP 508 requirement.', number)
        if requirement.url:
            fail('unsupported_source', 'URL, Git and local path dependencies are not supported.', number)
        requirement.name = canonicalize_name(requirement.name)
        if requirement.name in inventory and (requirement.marker is None or requirement.marker.evaluate()):
            if not requirement.specifier.contains(inventory[requirement.name], prereleases=True):
                fail('base_conflict', 'The requested version conflicts with the fixed base environment: ' + requirement.name + '.', number)
        normalized.append(str(requirement))
    if not normalized: fail('empty_requirements', 'Enter at least one package requirement.')
    return normalized

def inventory_matches(base):
    actual = {canonicalize_name(distribution.metadata['Name']): distribution.version for distribution in importlib.metadata.distributions() if distribution.metadata['Name']}
    expected = {canonicalize_name(item['name']): item['version'] for item in base}
    if actual != expected: fail('base_changed', 'The base image package inventory does not match its revision.')

def constraints(base):
    result = []
    for item in base:
        name = canonicalize_name(item['name'])
        version = str(Version(item['version']))
        if not re.fullmatch(r'[a-z0-9][a-z0-9.-]*', name): fail('base_changed', 'The base package inventory is invalid.')
        result.append(name + '==' + version)
    return '\n'.join(sorted(result)) + '\n'

def pip_command(arguments):
    # No inherited pip config/index, credential helpers, user site, or pip cache.
    return [sys.executable, '-I', '-m', 'pip', '--isolated', '--disable-pip-version-check', '--no-cache-dir'] + arguments

def run_pip(arguments, default_code, metadata_paths=None):
    command = pip_command(arguments)
    if metadata_paths is not None:
        # Startup hooks from installed wheels must never run during metadata checks.
        # -S skips site/.pth processing; pip and its code load from the trusted base first.
        bootstrap = 'import sys; sys.path[:] = ' + repr(metadata_paths) + '; from pip._internal.cli.main import main; raise SystemExit(main(' + repr(['--isolated', '--disable-pip-version-check'] + arguments) + '))'
        command = [sys.executable, '-I', '-S', '-c', bootstrap]
    with tempfile.TemporaryFile() as output:
        process = subprocess.Popen(command, stdout=output, stderr=subprocess.STDOUT)
        code = process.wait()
        if code:
            output.seek(0, 2); size = output.tell(); output.seek(max(0, size - 16384))
            log = output.read(16384).decode('utf-8', 'replace')
            if 'No space left on device' in log: fail('disk_full', 'There is not enough temporary storage to prepare these packages.')
            if 'ResolutionImpossible' in log or 'conflicting dependencies' in log: fail('dependency_conflict', 'Package versions conflict with each other or the fixed base environment.')
            if 'No matching distribution found' in log or 'Could not find a version that satisfies' in log:
                if default_code == 'resolution_failed':
                    match = re.search(r'No matching distribution found for ([A-Za-z0-9][A-Za-z0-9._-]*)', log)
                    if match:
                        # Only inspect project existence; never echo pip logs, index URLs or credentials.
                        try:
                            with urllib.request.urlopen('https://pypi.org/pypi/' + canonicalize_name(match.group(1)) + '/json', timeout=10): pass
                        except urllib.error.HTTPError as error:
                            if error.code == 404: fail('package_not_found', 'A requested package was not found on public PyPI: ' + canonicalize_name(match.group(1)) + '.')
                        except OSError: pass
                fail('wheel_unavailable', 'A requested package or version has no compatible binary wheel on PyPI.')
            if 'ProxyError' in log or 'ConnectionError' in log or 'ReadTimeout' in log or 'SSLError' in log:
                fail('network_error', 'PyPI could not be reached securely. Try preparing the packages again.')
            fail(default_code, 'Package resolution or offline verification failed.')

def safe_url(value):
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme != 'https' or parsed.hostname != 'files.pythonhosted.org' or parsed.port not in (None, 443) or parsed.username or parsed.password or parsed.fragment:
        fail('unsupported_source', 'Dependencies must be binary wheels from public PyPI.')
    return parsed

class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        safe_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)

def validate_wheel(file, expected_name, expected_version, expected_hash, remaining):
    if file.is_symlink() or not file.is_file() or not re.fullmatch(r'[A-Za-z0-9_.+!-]+\.whl', file.name):
        fail('invalid_wheel', 'An unsafe wheel file was rejected.')
    try: name, version, _, tags = parse_wheel_filename(file.name)
    except Exception: fail('invalid_wheel', 'An invalid wheel filename was rejected.')
    if canonicalize_name(name) != canonicalize_name(expected_name) or Version(expected_version) != version or not set(tags).intersection(sys_tags()):
        fail('invalid_wheel', 'A wheel does not match its expected package, version or platform.')
    digest = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(65536), b''): digest.update(chunk)
    if expected_hash and digest.hexdigest() != expected_hash: fail('hash_mismatch', 'A downloaded wheel failed its SHA-256 integrity check.')
    expanded = 0
    try:
        with zipfile.ZipFile(file) as archive:
            members = archive.infolist()
            if len(members) > 100000: fail('invalid_wheel', 'A wheel contains too many files.')
            names = set()
            for member in members:
                normalized_path = pathlib.PurePosixPath(member.filename)
                parts = normalized_path.parts
                if member.filename.rstrip('/') != str(normalized_path): fail('invalid_wheel', 'A wheel contains ambiguous archive paths.')
                kind = stat.S_IFMT(member.external_attr >> 16)
                if member.filename in names or not parts or member.filename.startswith('/') or '\\' in member.filename or any(part in ('.', '..') or ':' in part for part in parts) or kind not in (0, stat.S_IFREG, stat.S_IFDIR) or member.flag_bits & 1:
                    fail('invalid_wheel', 'A wheel contains unsafe archive entries.')
                names.add(member.filename)
                expanded += member.file_size
                if expanded > remaining: fail('installed_limit', 'The unpacked packages exceed the installed size limit.')
            metadata = [item for item in members if item.filename.endswith('.dist-info/METADATA') and item.filename.count('/') == 1]
            if len(metadata) != 1 or metadata[0].file_size > 2 * 1024 * 1024:
                fail('invalid_wheel', 'A wheel has invalid package metadata.')
            record = email.parser.BytesParser().parsebytes(archive.read(metadata[0]))
            if canonicalize_name(record.get('Name', '')) != canonicalize_name(expected_name) or Version(record.get('Version', '')) != Version(expected_version):
                fail('invalid_wheel', 'The wheel metadata does not match its filename.')
            for value in record.get_all('Requires-Dist', []):
                if Requirement(value).url: fail('unsupported_source', 'A package includes a prohibited URL dependency.')
            # Stream every entry: CRCs and actual decompression are bounded before pip sees it.
            actual = 0
            for member in members:
                with archive.open(member) as stream:
                    while True:
                        chunk = stream.read(65536)
                        if not chunk: break
                        actual += len(chunk)
                        if actual > remaining: fail('installed_limit', 'The unpacked packages exceed the installed size limit.')
    except PreparationFailure: raise
    except Exception: fail('invalid_wheel', 'A damaged or invalid wheel was rejected.')
    return {'name': canonicalize_name(expected_name), 'version': str(Version(expected_version)), 'fileName': file.name, 'sha256': digest.hexdigest(), 'bytes': file.stat().st_size}, expanded

def resolve(config):
    normalized = parse_requirements(config['requirementsText'], config['basePackages'])
    inventory_matches(config['basePackages'])
    emit({'state': 'resolving', 'normalizedRequirements': normalized, 'log': 'Checking package versions against the fixed base environment.'})
    pathlib.Path('/tmp/requirements.txt').write_text('\n'.join(normalized) + '\n')
    pathlib.Path('/tmp/constraints.txt').write_text(constraints(config['basePackages']))
    # --dry-run retains installed distributions, unlike pip download which downloads the base too.
    run_pip(['install', '--dry-run', '--report', '/tmp/report.json', '--only-binary=:all:', '--no-build-isolation', '--index-url', 'https://pypi.org/simple', '--retries', '1', '--timeout', '20', '-c', '/tmp/constraints.txt', '-r', '/tmp/requirements.txt'], 'resolution_failed')
    report_file = pathlib.Path('/tmp/report.json')
    if report_file.stat().st_size > 8 * 1024 * 1024: fail('resolution_failed', 'The dependency resolution report is too large.')
    report = json.loads(report_file.read_text())
    base = {canonicalize_name(item['name']) for item in config['basePackages']}
    packages, downloaded, expanded = [], 0, 0
    emit({'state': 'downloading', 'log': 'Downloading and validating additional binary wheels.'})
    opener = urllib.request.build_opener(SafeRedirect())
    planned = report.get('install', [])
    if len(planned) > 256: fail('resolution_failed', 'The package request resolves to too many dependencies.')
    for entry in planned:
        metadata = entry['metadata']
        name, version = canonicalize_name(metadata['name']), metadata['version']
        if name in base: fail('base_conflict', 'The request would replace a package in the fixed base environment: ' + name + '.')
        for requirement in metadata.get('requires_dist', []):
            if Requirement(requirement).url: fail('unsupported_source', 'A package includes a prohibited URL dependency.')
        info = entry['download_info']
        parsed = safe_url(info['url'])
        filename = urllib.parse.unquote(parsed.path.rsplit('/', 1)[-1])
        if not re.fullmatch(r'[A-Za-z0-9_.+!-]+\.whl', filename): fail('invalid_wheel', 'PyPI returned an unsafe wheel filename.')
        sha256 = info.get('archive_info', {}).get('hashes', {}).get('sha256', '')
        if not re.fullmatch(r'[0-9a-f]{64}', sha256): fail('hash_mismatch', 'PyPI did not provide a SHA-256 hash for a wheel.')
        file = pathlib.Path('/wheels') / filename
        try:
            with opener.open(info['url'], timeout=20) as response, file.open('xb') as output:
                if response.status != 200: fail('network_error', 'PyPI could not supply a requested wheel.')
                safe_url(response.url)
                while True:
                    chunk = response.read(65536)
                    if not chunk: break
                    downloaded += len(chunk)
                    if downloaded > config['maxDownloadBytes']: fail('download_limit', 'The wheel downloads exceed the configured size limit.')
                    output.write(chunk)
        except PreparationFailure: raise
        except OSError as error:
            if error.errno == 28: fail('disk_full', 'There is not enough storage for the wheel files.')
            fail('network_error', 'A wheel download failed. Try preparing the packages again.')
        package, size = validate_wheel(file, name, version, sha256, config['maxInstalledBytes'] - expanded)
        expanded += size; packages.append(package)
        emit({'state': 'downloading', 'downloadBytes': downloaded})
    packages.sort(key=lambda item: item['name'])
    if len({item['name'] for item in packages}) != len(packages): fail('invalid_wheel', 'Duplicate package wheels were rejected.')
    emit({'resolved': {'normalizedRequirements': normalized, 'packages': packages, 'downloadBytes': downloaded}})

def verify(config):
    manifest = config['resolved']
    expanded = 0
    expected = {item['fileName'] for item in manifest['packages']}
    if {file.name for file in pathlib.Path('/wheels').iterdir()} != expected: fail('invalid_wheel', 'The wheel bundle contains unexpected files.')
    for item in manifest['packages']:
        _, size = validate_wheel(pathlib.Path('/wheels') / item['fileName'], item['name'], item['version'], item['sha256'], config['maxInstalledBytes'] - expanded)
        expanded += size
    venv.EnvBuilder(system_site_packages=True, with_pip=False).create('/tmp/verified')
    overhead = sum(file.stat().st_size for file in pathlib.Path('/tmp/verified').rglob('*') if file.is_file() and not file.is_symlink())
    lock = '\n'.join(item['name'] + '==' + item['version'] + ' --hash=sha256:' + item['sha256'] for item in manifest['packages']) + '\n'
    pathlib.Path('/tmp/locked.txt').write_text(lock)
    if manifest['packages']:
        run_pip(['--python', '/tmp/verified/bin/python', 'install', '--no-index', '--find-links', '/wheels', '--no-deps', '--no-compile', '--only-binary=:all:', '--require-hashes', '-r', '/tmp/locked.txt'], 'verification_failed')
    site_packages = '/tmp/verified/lib/python%d.%d/site-packages' % sys.version_info[:2]
    installed_inventory = {canonicalize_name(distribution.metadata['Name']): distribution.version for distribution in importlib.metadata.distributions(path=[site_packages]) if distribution.metadata['Name']}
    expected_inventory = {item['name']: item['version'] for item in manifest['packages']}
    if installed_inventory != expected_inventory: fail('verification_failed', 'The installed package inventory does not match the wheel bundle.')
    # Scan the combined base/venv metadata using pip check, without importing entrant code.
    run_pip(['check'], 'verification_failed', metadata_paths=list(sys.path) + [site_packages])
    installed = 0
    for directory, directories, files in os.walk('/tmp/verified', followlinks=False):
        for name in files:
            file = pathlib.Path(directory) / name
            if not file.is_symlink(): installed += file.stat().st_size
            if installed > config['maxInstalledBytes'] + overhead: fail('installed_limit', 'The installed packages exceed the configured size limit.')
    emit({'verified': {'installedBytes': max(0, installed - overhead), 'lock': lock if manifest['packages'] else ''}})

if __name__ == '__main__':
    try:
        config = json.loads(pathlib.Path('/input/request.json').read_text())
        if sys.argv[1] == 'resolve': resolve(config)
        elif sys.argv[1] == 'verify': verify(config)
        else: fail('preparation_failed', 'Unknown preparation phase.')
    except PreparationFailure as error:
        emit({'error': {'code': error.code, 'message': error.message, 'line': error.line}})
        sys.exit(1)
    except OSError as error:
        emit({'error': {'code': 'disk_full' if error.errno == 28 else 'preparation_failed', 'message': 'Package preparation could not finish.'}})
        sys.exit(1)
    except Exception:
        emit({'error': {'code': 'preparation_failed', 'message': 'Package metadata or preparation output is invalid.'}})
        sys.exit(1)
`
