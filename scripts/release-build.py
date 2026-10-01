#!/usr/bin/env python3
"""Operator/CI image builder. Publish actual OCI digests; never build in the app.

Requires a checkout, Docker buildx and an authenticated target registry. The
release JSON is emitted only after every selected image has been pushed, or
found already published under its tag (publish.yml publishes the app, the
broker and the CPU kernels of every release; see published()).
"""
import argparse
import importlib.util
import json
import pathlib
import re
import subprocess
import tempfile
import tarfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('release', ROOT / 'scripts/release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


def command(args):
    return subprocess.check_output(args, cwd=ROOT, text=True).strip()


def archive_source(repository, commit, destination):
    if not re.fullmatch(r'[a-f0-9]{40}', commit):
        raise ValueError('source commit must be a full SHA')
    actual = subprocess.check_output(['git', 'rev-parse', '--verify', commit + '^{commit}'], cwd=repository, text=True).strip()
    if actual != commit:
        raise ValueError('source commit does not identify an exact commit')
    destination = pathlib.Path(destination)
    destination.mkdir(parents=True, exist_ok=False)
    with tempfile.TemporaryFile() as archive:
        subprocess.run(['git', 'archive', '--format=tar', commit], cwd=repository, stdout=archive, check=True)
        archive.seek(0)
        with tarfile.open(fileobj=archive, mode='r:') as source:
            # Extraction rejects paths/links outside the fresh build directory.
            source.extractall(destination, filter='data')
    return destination


def chain(name, done, visiting):
    if name in done:
        return
    if name in visiting:
        raise ValueError('environment inheritance cycle: ' + name)
    if not release.NAME.fullmatch(name):
        raise ValueError('invalid environment name: ' + name)
    visiting.add(name)
    source = (ROOT / 'kernel/environments' / (name + '.txt')).read_text()
    parents = re.findall(r'^#\s*colloq:\s*from\s+(\S+)\s*$', source, re.MULTILINE)
    if len(parents) > 1:
        raise ValueError('multiple environment parents: ' + name)
    parent = parents[0] if parents else None
    if parent:
        chain(parent, done, visiting)
    done[name] = {'source': source, 'parent': parent}
    visiting.remove(name)


GPU_DIRECTIVE = re.compile(r'^#\s*colloq:\s*gpu\s*$', re.MULTILINE)


def catalog_environment(name, environment, image, gpu_flags):
    """One kernel catalog entry, the way the app and the broker read it.

    release.json (main below) and the Helm chart's default values
    (scripts/chart-values.py) both come out of this function, so the two
    catalogs of one release cannot disagree about a package list or a GPU flag.
    `environment` is what chain() recorded; gpu_flags carries the decisions for
    the parents, since a child of a GPU environment is one too, and gets this
    one's decision added.
    """
    gpu = bool(GPU_DIRECTIVE.search(environment['source'])) or gpu_flags.get(environment['parent'], False)
    gpu_flags[name] = gpu
    packages = [line.strip() for line in environment['source'].splitlines()
                if line.strip() and not line.lstrip().startswith(('#', '-'))]
    return {'name': name, 'image': image, 'gpu': gpu, 'packages': packages, 'current': True}


def data_schema(root):
    """The data schema version the server at this source writes.

    It used to be a literal 1 here while destructive migrations shipped, so the
    rollback check in cluster.sh compared 1 with 1 and could never refuse. The
    number lives in one place, next to the code that migrates the database
    (server/src/data-schema.ts), and is read from the archived source, never
    from the working tree.
    """
    source = (pathlib.Path(root) / 'server/src/data-schema.ts').read_text()
    found = re.findall(r'^export const DATA_SCHEMA_VERSION = ([0-9]+)\s*$', source, re.MULTILINE)
    if len(found) != 1 or int(found[0]) < 1:
        raise ValueError('server/src/data-schema.ts must declare exactly one DATA_SCHEMA_VERSION = <positive integer>')
    return int(found[0])


def published(tag):
    """The digest a tag already names in the registry, or None.

    publish.yml pushes colloq-app, colloq-runtime and the CPU kernels under
    these very tags as soon as a release is made, and the Helm chart it
    publishes pins their digests. Building them again here would move the tags
    to a second build of the same commit: the chart would keep installing images
    no tag names any more, and a registry mirror that copies by tag would copy
    the other ones. So a tag that exists is taken as it is, the way publish.yml
    itself treats one on a rerun.
    """
    try:
        found = subprocess.run(['docker', 'buildx', 'imagetools', 'inspect', tag, '--format', '{{.Manifest.Digest}}'],
                               cwd=ROOT, text=True, capture_output=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired):
        return None
    digest = found.stdout.strip()
    return digest if found.returncode == 0 and re.fullmatch(r'sha256:[a-f0-9]{64}', digest) else None


def build(tag, dockerfile, context, args, metadata, target=None):
    digest = published(tag)
    if digest:
        print('Already published, taken as it is: ' + tag + ' (' + digest + ')')
        return tag.rsplit(':', 1)[0] + '@' + digest
    cmd = ['docker', 'buildx', 'build', '--platform', 'linux/amd64', '--push',
           '--provenance=mode=max', '--sbom=true', '--metadata-file', str(metadata),
           '-t', tag, '-f', dockerfile]
    if target:
        cmd += ['--target', target]
    for key, value in args.items():
        cmd += ['--build-arg', key + '=' + value]
    subprocess.run(cmd + [context], cwd=ROOT, check=True)
    digest = json.loads(metadata.read_text()).get('containerimage.digest', '')
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', digest):
        raise ValueError('buildx did not return a real image digest')
    return tag.rsplit(':', 1)[0] + '@' + digest


def pinned(base):
    digest = command(['docker', 'buildx', 'imagetools', 'inspect', base, '--format', '{{.Manifest.Digest}}'])
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', digest):
        raise ValueError('cannot resolve base image digest: ' + base)
    return base + '@' + digest


def main():
    global ROOT
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version', help='release tag; defaults to v<package.json version> at --source-commit')
    parser.add_argument('--registry', required=True, help='repository prefix, e.g. ghcr.io/owner/colloq')
    parser.add_argument('--k3s-version', required=True)
    parser.add_argument('--environments', default='base,kaggle-base')
    parser.add_argument('--default-environment', default='base')
    parser.add_argument('--source-commit', required=True)
    parser.add_argument('--gpu-toolkit-version')
    parser.add_argument('--gpu-device-plugin-image')
    parser.add_argument('--output', default='release.json')
    args = parser.parse_args()
    if '/' not in args.registry or not release.image_reference(args.registry + '-runtime@sha256:' + '0' * 64):
        parser.error('--registry must be a lowercase registry/repository prefix')
    if args.version is not None and not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}', args.version):
        parser.error('invalid release version')
    output = pathlib.Path(args.output).resolve()
    build_context = tempfile.TemporaryDirectory(prefix='colloq-source-')
    # All Dockerfiles, COPY inputs and package lists come from this exact commit.
    # Live tracked edits, ignored files and untracked files never enter the build.
    ROOT = archive_source(ROOT, args.source_commit, pathlib.Path(build_context.name) / 'source')
    # The release version is the source's version: the root package.json at
    # that exact commit (release-please bumps every copy together, and
    # scripts/version.mts check holds them equal).
    # A free-form --version used to label images independently of the code
    # inside them, so :v0.2.0 could hold a tree that still called itself 0.1.0.
    expected = 'v' + str(json.loads((ROOT / 'package.json').read_text()).get('version', ''))
    if args.version is None:
        args.version = expected
    elif args.version != expected:
        parser.error(f'--version {args.version} does not match package.json at {args.source_commit[:12]} '
                     f'({expected}); release that version through the release-please pull request and build its tag')
    if not re.fullmatch(r'v[A-Za-z0-9][A-Za-z0-9._-]{0,62}', args.version):
        parser.error('package.json at the source commit has no usable version')
    selected = [name for name in args.environments.split(',') if name]
    ordered = {}
    for name in selected:
        chain(name, ordered, set())
    gpu_tooling = None
    if any(GPU_DIRECTIVE.search(env['source']) for env in ordered.values()):
        if not args.gpu_toolkit_version or not re.fullmatch(r'\d+\.\d+\.\d+(?:[.+~-][A-Za-z0-9.]+)?-\d+', args.gpu_toolkit_version):
            parser.error('GPU environments require --gpu-toolkit-version with an exact apt version')
        if not release.image_reference(args.gpu_device_plugin_image):
            parser.error('GPU environments require --gpu-device-plugin-image pinned by sha256')
        gpu_tooling = {'toolkitVersion': args.gpu_toolkit_version, 'devicePluginImage': args.gpu_device_plugin_image}
    # Every migration runs forward from any older file, so a release opens data
    # of its own schema and of every earlier one, and nothing newer.
    schema = data_schema(ROOT)
    node, python = pinned('node:22-trixie-slim'), pinned('python:3.11-slim-bookworm')
    value = {'schemaVersion': 1, 'version': args.version, 'sourceCommit': args.source_commit,
        'k3sVersion': args.k3s_version, 'dataSchemaVersion': schema,
        'compatibleDataSchemaVersions': list(range(1, schema + 1)),
        'buildInputs': {'nodeImage': node, 'pythonImage': python},
        'catalog': {'schemaVersion': 1, 'release': args.version,
            'defaultEnvironment': args.default_environment, 'environments': []}}
    value['tooling'] = {'sourceFiles': release.tooling_hashes(ROOT)}
    if gpu_tooling:
        value['tooling']['gpu'] = gpu_tooling
    with tempfile.TemporaryDirectory(prefix='colloq-build-') as tmp:
        metadata = pathlib.Path(tmp) / 'image.json'
        for kind, target in [('app', 'production'), ('runtime', 'broker')]:
            value[kind + 'Image'] = build(args.registry + '-' + kind + ':' + args.version,
                'Dockerfile', '.', {'NODE_IMAGE': node}, metadata, target)
        images, gpu_flags = {}, {}
        for name, environment in ordered.items():
            parent = environment['parent']
            image = build(args.registry + '-kernel:' + args.version + '-' + name,
                'kernel/Dockerfile', 'kernel', {'PARENT': images[parent] if parent else python,
                'KERNEL_ENV': name}, metadata)
            images[name] = image
            value['catalog']['environments'].append(catalog_environment(name, environment, image, gpu_flags))
    release.validate(value)
    output.write_text(json.dumps(value, indent=2) + '\n')
    build_context.cleanup()
    print('Published immutable release manifest: ' + str(output))


if __name__ == '__main__':
    main()
