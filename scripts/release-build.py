#!/usr/bin/env python3
"""Operator/CI image builder. Publish actual OCI digests; never build in the app.

Requires a checkout, Docker buildx and an authenticated target registry. The
release JSON is emitted only after every selected image has been pushed.
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


def build(tag, dockerfile, context, args, metadata, target=None):
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
    return tag.split(':', 1)[0] + '@' + digest


def pinned(base):
    digest = command(['docker', 'buildx', 'imagetools', 'inspect', base, '--format', '{{.Manifest.Digest}}'])
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', digest):
        raise ValueError('cannot resolve base image digest: ' + base)
    return base + '@' + digest


def main():
    global ROOT
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version', required=True)
    parser.add_argument('--registry', required=True, help='repository prefix, e.g. ghcr.io/owner/colloq')
    parser.add_argument('--k3s-version', required=True)
    parser.add_argument('--environments', default='base,cv,gpu')
    parser.add_argument('--default-environment', default='base')
    parser.add_argument('--source-commit', required=True)
    parser.add_argument('--gpu-toolkit-version')
    parser.add_argument('--gpu-device-plugin-image')
    parser.add_argument('--output', default='release.json')
    args = parser.parse_args()
    if not re.fullmatch(r'[a-z0-9][a-z0-9.-]*/[a-z0-9][a-z0-9._/-]*', args.registry):
        parser.error('--registry must be a lowercase registry/repository prefix')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}', args.version):
        parser.error('invalid release version')
    output = pathlib.Path(args.output).resolve()
    build_context = tempfile.TemporaryDirectory(prefix='colloq-source-')
    # All Dockerfiles, COPY inputs and package lists come from this exact commit.
    # Live tracked edits, ignored files and untracked files never enter the build.
    ROOT = archive_source(ROOT, args.source_commit, pathlib.Path(build_context.name) / 'source')
    selected = [name for name in args.environments.split(',') if name]
    ordered = {}
    for name in selected:
        chain(name, ordered, set())
    gpu_tooling = None
    if any(re.search(r'^#\s*colloq:\s*gpu\s*$', env['source'], re.MULTILINE) for env in ordered.values()):
        if not args.gpu_toolkit_version or not re.fullmatch(r'\d+\.\d+\.\d+(?:[.+~-][A-Za-z0-9.]+)?-\d+', args.gpu_toolkit_version):
            parser.error('GPU environments require --gpu-toolkit-version with an exact apt version')
        if not release.image_reference(args.gpu_device_plugin_image):
            parser.error('GPU environments require --gpu-device-plugin-image pinned by sha256')
        gpu_tooling = {'toolkitVersion': args.gpu_toolkit_version, 'devicePluginImage': args.gpu_device_plugin_image}
    node, python = pinned('node:22-bookworm-slim'), pinned('python:3.11-slim-bookworm')
    value = {'schemaVersion': 1, 'version': args.version, 'sourceCommit': args.source_commit,
        'k3sVersion': args.k3s_version, 'dataSchemaVersion': 1, 'compatibleDataSchemaVersions': [1],
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
            gpu = bool(re.search(r'^#\s*colloq:\s*gpu\s*$', environment['source'], re.MULTILINE)) or gpu_flags.get(parent, False)
            image = build(args.registry + '-kernel:' + args.version + '-' + name,
                'kernel/Dockerfile', 'kernel', {'PARENT': images[parent] if parent else python,
                'KERNEL_ENV': name}, metadata)
            images[name], gpu_flags[name] = image, gpu
            packages = [line.strip() for line in environment['source'].splitlines()
                        if line.strip() and not line.lstrip().startswith(('#', '-'))]
            value['catalog']['environments'].append({'name': name, 'image': image, 'gpu': gpu, 'packages': packages, 'current': True})
    release.validate(value)
    output.write_text(json.dumps(value, indent=2) + '\n')
    build_context.cleanup()
    print('Published immutable release manifest: ' + str(output))


if __name__ == '__main__':
    main()
