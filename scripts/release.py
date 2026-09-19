#!/usr/bin/env python3
"""Validate immutable Colloq releases and render single-node Kubernetes resources.

Only Python's standard library is needed on the deployment host. Output is JSON,
which kubectl accepts directly; no templating engine or YAML dependency is needed.
"""
import argparse
import copy
import hashlib
import importlib.util
import json
import os
import re
import sys
import subprocess
from pathlib import Path

# Same canonical reference grammar and bounds as shared/runtime.ts.
IMAGE = re.compile(r'^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[a-f0-9]{64}$')
NAME = re.compile(r'^(?:[a-z0-9][a-z0-9-]{0,30}[a-z0-9]|[a-z0-9])$')
NAMESPACE = 'colloq'
TOOLING_FILES = tuple('scripts/' + name for name in (
    'cluster.sh', 'release.py', 'state-lock.py', 'backup.sh', 'runtime-backup.py',
    'restore.sh', 'host.sh', 'lib.sh'))


def require(condition, message):
    if not condition:
        raise ValueError(message)


def image_reference(value):
    return isinstance(value, str) and len(value) <= 512 and IMAGE.fullmatch(value)


def string_length(value):
    # JavaScript string.length counts UTF-16 code units, including surrogate pairs.
    return len(value.encode('utf-16-le', errors='surrogatepass')) // 2


def validate(value):
    require(isinstance(value, dict) and type(value.get('schemaVersion')) is int and value['schemaVersion'] == 1, 'release schemaVersion must be 1')
    require(isinstance(value.get('version'), str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}', value['version']), 'version must be an explicit release identifier')
    require(re.fullmatch(r'[a-f0-9]{40}', str(value.get('sourceCommit', ''))), 'sourceCommit must be a full commit SHA')
    require(re.fullmatch(r'v\d+\.\d+\.\d+\+k3s\d+', str(value.get('k3sVersion', ''))), 'k3sVersion must pin an exact vX.Y.Z+k3sN release')
    # The room memory field is applied to a live Pod through pods/resize, which
    # Kubernetes enables by default from 1.33. An older cluster would accept the
    # form's number and never apply it while the room runs.
    require(tuple(int(x) for x in value['k3sVersion'][1:].split('+')[0].split('.')[:2]) >= (1, 33),
            'k3sVersion must be v1.33 or newer: room memory is resized in place')
    for key in ('appImage', 'runtimeImage'):
        require(image_reference(value.get(key)), f'{key} must be a registry image pinned by sha256 digest')
    require(type(value.get('dataSchemaVersion')) is int and value['dataSchemaVersion'] >= 1, 'dataSchemaVersion must be a positive integer')
    compatible = value.get('compatibleDataSchemaVersions')
    require(isinstance(compatible, list) and compatible and all(type(v) is int and v >= 1 for v in compatible), 'compatibleDataSchemaVersions must list supported schemas')
    require(value['dataSchemaVersion'] in compatible, 'compatibleDataSchemaVersions must include dataSchemaVersion')
    catalog = value.get('catalog')
    require(isinstance(catalog, dict) and type(catalog.get('schemaVersion')) is int and catalog['schemaVersion'] == 1, 'catalog schemaVersion must be 1')
    require(set(catalog) <= {'schemaVersion', 'release', 'defaultEnvironment', 'environments'}, 'unknown catalog fields are not allowed')
    require(catalog.get('release') == value['version'], 'catalog release must match version')
    require(isinstance(catalog.get('environments'), list) and 0 < len(catalog['environments']) <= 1000, 'catalog requires 1..1000 environment revisions')
    current, revisions, groups = set(), set(), {}
    for env in catalog['environments']:
        require(isinstance(env, dict), 'environment must be an object')
        require(set(env) <= {'name', 'image', 'gpu', 'packages', 'current'}, 'unknown environment fields are not allowed')
        name = env.get('name')
        require(isinstance(name, str) and NAME.fullmatch(name), 'environment name is invalid')
        require(image_reference(env.get('image')), 'environment image must be pinned by sha256 digest')
        require(type(env.get('gpu')) is bool, 'environment gpu must be boolean')
        require('current' not in env or type(env['current']) is bool, 'environment current must be boolean')
        require('packages' not in env or (isinstance(env['packages'], list) and len(env['packages']) <= 2000 and all(isinstance(p, str) and string_length(p) <= 512 for p in env['packages'])), 'environment packages must contain at most 2000 strings of at most 512 characters')
        identity = (name, env['image'].split('@', 1)[1])
        require(identity not in revisions, 'duplicate environment revision')
        revisions.add(identity)
        groups.setdefault(name, []).append(env)
    for name, entries in groups.items():
        if len(entries) == 1 and 'current' not in entries[0]:
            entries[0]['current'] = True
        require(sum(e.get('current') is True for e in entries) == 1, f'environment {name} requires exactly one current revision')
        for entry in entries:
            entry['current'] = entry.get('current') is True
        current.add(name)
    require(catalog.get('defaultEnvironment') in current, 'defaultEnvironment must select a current environment')
    if any(e['gpu'] for e in catalog['environments']):
        gpu = value.get('tooling', {}).get('gpu', {})
        require(re.fullmatch(r'\d+\.\d+\.\d+(?:[.+~-][A-Za-z0-9.]+)?-\d+', str(gpu.get('toolkitVersion', ''))),
                'GPU catalog requires tooling.gpu.toolkitVersion pinned to an exact apt package version')
        require(image_reference(gpu.get('devicePluginImage')),
                'GPU catalog requires tooling.gpu.devicePluginImage pinned by sha256')
    return value


def read(file):
    with open(file, encoding='utf-8') as stream:
        return validate(json.load(stream))


def merge(value, previous, rollback=False, data_schema=None):
    require((previous['dataSchemaVersion'] if data_schema is None else data_schema) in value['compatibleDataSchemaVersions'],
            'incompatible data schema: restore the matching backup before installing this release')
    result = copy.deepcopy(value)
    entries = result['catalog']['environments']
    names = {entry['name'] for entry in entries}
    known = {(e['name'], e['image'].split('@', 1)[1]): e for e in entries}
    for entry in entries:
        entry['current'] = entry.get('current', True)
    for entry in previous['catalog']['environments']:
        identity = (entry['name'], entry['image'].split('@', 1)[1])
        if identity not in known:
            entries.append({**entry, 'current': entry['current'] if entry['name'] not in names else False})
        else:
            newer = known[identity]
            require(newer['gpu'] == entry['gpu'] and sorted(newer.get('packages', [])) == sorted(entry.get('packages', [])),
                    'conflicting metadata for retained environment revision: ' + entry['name'])
    if any(e['gpu'] for e in entries) and not result.get('tooling', {}).get('gpu'):
        result.setdefault('tooling', {})['gpu'] = copy.deepcopy(previous.get('tooling', {}).get('gpu'))
    return validate(result)


def tooling_hashes(root):
    root = Path(root)
    result = {}
    for name in TOOLING_FILES:
        file = root / name
        require(file.is_file() and not file.is_symlink(), 'missing regular source tooling file: ' + name)
        result[name] = hashlib.sha256(file.read_bytes()).hexdigest()
    return result


def verify_tooling(value, root):
    root = Path(root).resolve()
    actual = tooling_hashes(root)
    expected = value.get('tooling', {}).get('sourceFiles')
    if expected is not None:
        require(isinstance(expected, dict) and set(expected) == set(TOOLING_FILES),
                'release tooling.sourceFiles must identify every archived deployment tool')
        for name, digest in actual.items():
            require(expected[name] == digest, 'deployment tooling differs from release source: ' + name)
        return
    # A source checkout can prove the same identity without an archived bundle.
    # Comparing actual bytes catches staged edits and modifications to the checker.
    try:
        commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, stderr=subprocess.DEVNULL, text=True).strip()
        require(commit == value['sourceCommit'], 'deployment tooling checkout does not match release.sourceCommit')
        for name, digest in actual.items():
            source = subprocess.check_output(['git', 'show', f'{commit}:{name}'], cwd=root, stderr=subprocess.DEVNULL)
            require(hashlib.sha256(source).hexdigest() == digest, 'deployment tooling is modified: ' + name)
    except subprocess.CalledProcessError as error:
        raise ValueError('Git-less deployment requires verified archived tooling.sourceFiles hashes') from error


def read_env(file):
    """Lines KEY=VALUE of an operator env file, read as data and never sourced."""
    settings = {}
    with open(file, encoding='utf-8') as stream:
        for line in stream:
            key, separator, val = line.strip().partition('=')
            if separator:
                settings[key] = val.strip().strip('\"\'')
    return settings


# Настройки брокера из того же файла оператора, что и настройки приложения.
# Раньше их не было в Deployment вовсе: единственный способ задать память
# комнаты по умолчанию и потолок был править Deployment руками, а следующий
# update рендерил его заново и молча стирал правку. Теперь они живут в
# config.env рядом с PUBLIC_URL и переживают update так же, как он.
RUNTIME_SETTINGS = ('RUNTIME_KERNEL_MEMORY', 'RUNTIME_KERNEL_MEMORY_MAX')
# Умолчание брокера (runtime/src/config.ts): с ним сравнивается заданный потолок.
RUNTIME_DEFAULT_MEMORY = '2Gi'


def memory_mi(value):
    # Та же грамматика и те же границы, что у брокера: целые Mi/Gi от 64Mi до
    # 256Gi. Проверка здесь — чтобы плохое число остановило установку до того,
    # как остановлены комнаты, а не уронило брокер в CrashLoop после.
    match = re.fullmatch(r'([1-9][0-9]*)(Mi|Gi)', value)
    mi = int(match.group(1)) * (1024 if match.group(2) == 'Gi' else 1) if match else 0
    return mi if 64 <= mi <= 262144 else None


def runtime_settings(file):
    settings = {}
    if file:
        # Пустое значение — «как по умолчанию»: пустая переменная окружения
        # брокеру не умолчание, а неразборчивое число.
        settings = {key: val for key, val in read_env(file).items() if key in RUNTIME_SETTINGS and val}
    for key, val in settings.items():
        require(memory_mi(val), f'{key} must be a Kubernetes quantity in whole Mi or Gi from 64Mi to 256Gi, e.g. 4Gi')
    if 'RUNTIME_KERNEL_MEMORY_MAX' in settings:
        # Без потолка брокер сам берёт память узла минус гигабайт и умолчание под
        # него подгоняет; заданный потолок ниже умолчания он отвергает при старте.
        default = settings.get('RUNTIME_KERNEL_MEMORY', RUNTIME_DEFAULT_MEMORY)
        require(memory_mi(default) <= memory_mi(settings['RUNTIME_KERNEL_MEMORY_MAX']),
                f'RUNTIME_KERNEL_MEMORY ({default}) exceeds RUNTIME_KERNEL_MEMORY_MAX')
    return settings


def resource(kind, name, spec=None, **fields):
    api = {'Deployment': 'apps/v1', 'DaemonSet': 'apps/v1', 'RuntimeClass': 'node.k8s.io/v1', 'Role': 'rbac.authorization.k8s.io/v1',
           'RoleBinding': 'rbac.authorization.k8s.io/v1', 'NetworkPolicy': 'networking.k8s.io/v1'}.get(kind, 'v1')
    value = {'apiVersion': api, 'kind': kind, 'metadata': {'name': name}}
    if kind not in ('Namespace', 'PersistentVolume', 'RuntimeClass'):
        value['metadata']['namespace'] = NAMESPACE
    if spec is not None:
        value['spec'] = spec
    return {**value, **fields}


def render(value, node_name, state_dir, runtime_env=None):
    require(re.fullmatch(r'[a-z0-9][a-z0-9.-]*', node_name), 'node name is invalid')
    require(os.path.isabs(state_dir) and '..' not in state_dir.split('/'), 'state-dir must be an absolute normalized path')
    items = [resource('Namespace', NAMESPACE)]
    policy_version = re.match(r'v\d+\.\d+', value['k3sVersion']).group()
    items[0]['metadata']['labels'] = {'pod-security.kubernetes.io/enforce': 'restricted',
                                    'pod-security.kubernetes.io/enforce-version': policy_version,
                                    'pod-security.kubernetes.io/audit': 'restricted',
                                    'pod-security.kubernetes.io/audit-version': policy_version,
                                    'pod-security.kubernetes.io/warn': 'restricted',
                                    'pod-security.kubernetes.io/warn-version': policy_version}
    for suffix, size in [('data', '10Gi'), ('workspace', '100Gi')]:
        name = 'colloq-' + suffix
        items.append(resource('PersistentVolume', name, {
            'capacity': {'storage': size}, 'volumeMode': 'Filesystem', 'accessModes': ['ReadWriteOnce'],
            'persistentVolumeReclaimPolicy': 'Retain', 'storageClassName': '',
            'local': {'path': os.path.join(state_dir, suffix)},
            'claimRef': {'namespace': NAMESPACE, 'name': name},
            'nodeAffinity': {'required': {'nodeSelectorTerms': [{'matchExpressions': [
                {'key': 'kubernetes.io/hostname', 'operator': 'In', 'values': [node_name]}]}]}}}))
        items.append(resource('PersistentVolumeClaim', name, {'accessModes': ['ReadWriteOnce'],
            'storageClassName': '', 'volumeName': name, 'resources': {'requests': {'storage': size}}}))
    items.append(resource('ConfigMap', 'colloq-catalog', data={'catalog.json': json.dumps(value['catalog'])}))
    for name in ['colloq-app', 'colloq-runtime', 'colloq-kernel']:
        items.append(resource('ServiceAccount', name, automountServiceAccountToken=False))
    # pods/resize is the only write beyond create/delete: it changes a live room's
    # container resources in place (Kubernetes 1.33+), so a memory raise mid-class
    # keeps the room's Python. It cannot alter image, command, mounts or security.
    items.append(resource('Role', 'colloq-runtime', rules=[{'apiGroups': [''],
        'resources': ['pods', 'services'], 'verbs': ['get', 'list', 'create', 'delete']},
        {'apiGroups': [''], 'resources': ['pods/resize'], 'verbs': ['patch']}]))
    items.append(resource('RoleBinding', 'colloq-runtime', roleRef={'apiGroup': 'rbac.authorization.k8s.io',
        'kind': 'Role', 'name': 'colloq-runtime'}, subjects=[{'kind': 'ServiceAccount',
        'name': 'colloq-runtime', 'namespace': NAMESPACE}]))
    security = {'runAsNonRoot': True, 'runAsUser': 1000, 'runAsGroup': 1000,
                'fsGroup': 1000, 'fsGroupChangePolicy': 'OnRootMismatch',
                'seccompProfile': {'type': 'RuntimeDefault'}}
    container_security = {'allowPrivilegeEscalation': False, 'readOnlyRootFilesystem': True,
                          'capabilities': {'drop': ['ALL']}}
    catalog_volume = {'name': 'catalog', 'configMap': {'name': 'colloq-catalog'}}
    token_volume = {'name': 'runtime-token', 'secret': {'secretName': 'colloq-runtime-auth',
                    'defaultMode': 0o440, 'items': [{'key': 'runtime-token', 'path': 'runtime-token'}]}}
    for role in ('app', 'runtime'):
        name = 'colloq-' + role
        labels = {'app.kubernetes.io/name': name, 'colloq.dev/role': role}
        app = role == 'app'
        port = 3000 if app else 8787
        env = {'NODE_ENV': 'production'}
        volumes = [catalog_volume, token_volume, {'name': 'tmp', 'emptyDir': {'sizeLimit': '256Mi'}}]
        mounts = [{'name': 'catalog', 'mountPath': '/etc/colloq', 'readOnly': True},
                  {'name': 'runtime-token', 'mountPath': '/run/secrets', 'readOnly': True},
                  {'name': 'tmp', 'mountPath': '/tmp'}]
        if app:
            env.update({'PORT': '3000', 'BIND_ADDR': '0.0.0.0', 'DATA_DIR': '/data', 'WORKSPACE_DIR': '/workspace',
                'KERNEL_BACKEND': 'broker', 'KERNEL_RUNTIME_URL': 'http://colloq-runtime:8787',
                'KERNEL_RUNTIME_TOKEN_FILE': '/run/secrets/runtime-token',
                'KERNEL_CATALOG_FILE': '/etc/colloq/catalog.json'})
            for suffix in ('data', 'workspace'):
                volumes.append({'name': suffix, 'persistentVolumeClaim': {'claimName': 'colloq-' + suffix}})
                mounts.append({'name': suffix, 'mountPath': '/' + suffix})
        else:
            # /var/run is a symlink to /run in the image. Mounting our read-only
            # secret at /run/secrets prevents creation of Kubernetes' nested SA
            # projection at /var/run/secrets/kubernetes.io/serviceaccount.
            mounts[1]['mountPath'] = '/etc/colloq-runtime-auth'
            env.update({'RUNTIME_PORT': '8787', 'RUNTIME_TOKEN_FILE': '/etc/colloq-runtime-auth/runtime-token',
                'RUNTIME_ROOM_SECRET_FILE': '/run/room-secret/room-secret', 'RUNTIME_CATALOG_FILE': '/etc/colloq/catalog.json',
                'RUNTIME_NAMESPACE': NAMESPACE, 'RUNTIME_WORKSPACE_CLAIM': 'colloq-workspace',
                'RUNTIME_IMAGE_PULL_SECRET': 'colloq-registry',
                'RUNTIME_KUBE_URL': 'https://kubernetes.default.svc',
                'RUNTIME_KUBE_TOKEN_FILE': '/var/run/secrets/kubernetes.io/serviceaccount/token',
                'RUNTIME_KUBE_CA_FILE': '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt'})
            env.update(runtime_env or {})
            volumes.append({'name': 'room-secret', 'secret': {'secretName': 'colloq-room-secret', 'defaultMode': 0o440}})
            mounts.append({'name': 'room-secret', 'mountPath': '/run/room-secret', 'readOnly': True})
        container = {'name': role, 'image': value['appImage' if app else 'runtimeImage'],
            'imagePullPolicy': 'IfNotPresent', 'ports': [{'containerPort': port, 'name': 'http'}],
            'env': [{'name': k, 'value': v} for k, v in env.items()], 'volumeMounts': mounts,
            'securityContext': container_security,
            'resources': {'requests': {'cpu': '250m' if app else '100m', 'memory': '256Mi' if app else '128Mi'},
                          'limits': {'cpu': '2' if app else '1', 'memory': '2Gi' if app else '512Mi'}},
            'livenessProbe': {**({'httpGet': {'path': '/api/livez', 'port': port}} if app else {'tcpSocket': {'port': port}}), 'initialDelaySeconds': 10, 'periodSeconds': 10},
            'readinessProbe': {'httpGet': {'path': '/api/health', 'port': port}, 'periodSeconds': 5} if app else
                              {'tcpSocket': {'port': port}, 'periodSeconds': 5}}
        if app:
            container['envFrom'] = [{'secretRef': {'name': 'colloq-app-config'}}]
        items.append(resource('Deployment', name, {'replicas': 0, 'strategy': {'type': 'Recreate'},
            'selector': {'matchLabels': labels}, 'template': {'metadata': {'labels': labels,
            'annotations': {'colloq.dev/release': value['version']}}, 'spec': {
                'serviceAccountName': name, 'automountServiceAccountToken': not app,
                'securityContext': security, 'terminationGracePeriodSeconds': 30,
                'nodeSelector': {'kubernetes.io/hostname': node_name},
                'imagePullSecrets': [{'name': 'colloq-registry'}], 'containers': [container], 'volumes': volumes}}}))
        items.append(resource('Service', name, {'type': 'NodePort' if app else 'ClusterIP',
            'selector': labels, 'ports': [{'name': 'http', 'port': port, 'targetPort': port,
                                         **({'nodePort': 30080} if app else {})}]}))
    select = lambda role: {'podSelector': {'matchLabels': {'colloq.dev/role': role}}}
    items.append(resource('NetworkPolicy', 'room-isolation', {'podSelector': {'matchLabels': {'colloq.dev/role': 'kernel'}},
        'policyTypes': ['Ingress', 'Egress'], 'ingress': [{'from': [select('app'), select('runtime')],
            'ports': [{'protocol': 'TCP', 'port': 8888}]}], 'egress': [{
                'to': [{'namespaceSelector': {'matchLabels': {'kubernetes.io/metadata.name': 'kube-system'}},
                        'podSelector': {'matchLabels': {'k8s-app': 'kube-dns'}}}],
                'ports': [{'protocol': 'UDP', 'port': 53}, {'protocol': 'TCP', 'port': 53}]}]}))
    items.append(resource('NetworkPolicy', 'runtime-ingress', {'podSelector': {'matchLabels': {'colloq.dev/role': 'runtime'}},
        'policyTypes': ['Ingress'], 'ingress': [{'from': [select('app')], 'ports': [{'protocol': 'TCP', 'port': 8787}]}]}))
    items.append(resource('NetworkPolicy', 'app-ingress', {'podSelector': {'matchLabels': {'colloq.dev/role': 'app'}},
        'policyTypes': ['Ingress'], 'ingress': [{'from': [{'ipBlock': {'cidr': '127.0.0.0/8'}}],
            'ports': [{'protocol': 'TCP', 'port': 3000}]}]}))
    return {'apiVersion': 'v1', 'kind': 'List', 'items': items}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['validate', 'render', 'merge', 'images', 'field', 'config', 'prepull', 'gpu', 'gpu-smoke', 'verify-tooling', 'consume-recovery'])
    parser.add_argument('--release', required=True)
    parser.add_argument('--previous')
    parser.add_argument('--data-release')
    parser.add_argument('--tooling-root', default=str(Path(__file__).resolve().parent.parent))
    parser.add_argument('--rollback', action='store_true')
    parser.add_argument('--node-name', default='colloq')
    parser.add_argument('--state-dir', default='/var/lib/colloq')
    parser.add_argument('--field')
    parser.add_argument('--env-file')
    args = parser.parse_args()
    value = read(args.release)
    if args.previous:
        value = merge(value, read(args.previous), args.rollback,
                      read(args.data_release)['dataSchemaVersion'] if args.data_release else None)
    elif args.data_release:
        require(read(args.data_release)['dataSchemaVersion'] in value['compatibleDataSchemaVersions'],
                'incompatible restored data schema: select a compatible release or matching backup')
    if args.command == 'consume-recovery':
        spec = importlib.util.spec_from_file_location('state_lock', Path(__file__).with_name('state-lock.py'))
        lock = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(lock)
        lock.acquire(args.state_dir)
        state = Path(args.state_dir)
        marker = state / '.restore-in-progress'
        require(not marker.exists() and not marker.is_symlink(), 'incomplete restore is in progress')
        recovery = state / 'recovery/release.json'
        if recovery.exists():
            require(read(recovery)['dataSchemaVersion'] in value['compatibleDataSchemaVersions'],
                    'selected release is incompatible with restored data schema')
            recovery.replace(recovery.with_name('applied-release.json'))
            directory = os.open(recovery.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    elif args.command == 'verify-tooling':
        verify_tooling(value, args.tooling_root)
        print('verified deployment tooling for ' + value['sourceCommit'])
    elif args.command == 'render':
        print(json.dumps(render(value, args.node_name, args.state_dir, runtime_settings(args.env_file)), indent=2))
    elif args.command == 'merge':
        print(json.dumps(value, indent=2))
    elif args.command == 'images':
        print('\n'.join(dict.fromkeys([value['appImage'], value['runtimeImage']] + [e['image'] for e in value['catalog']['environments']])))
    elif args.command == 'field':
        require(args.field in ('version', 'k3sVersion', 'policyVersion', 'dataSchemaVersion', 'gpu', 'toolkitVersion'), 'unsupported field')
        if args.field == 'gpu':
            print('true' if any(e['gpu'] for e in value['catalog']['environments']) else 'false')
        elif args.field == 'toolkitVersion':
            print(value.get('tooling', {}).get('gpu', {}).get('toolkitVersion', ''))
        elif args.field == 'policyVersion':
            print(re.match(r'v\d+\.\d+', value['k3sVersion']).group())
        else:
            print(value[args.field])
    elif args.command == 'gpu':
        gpu = value.get('tooling', {}).get('gpu')
        require(gpu, 'this release has no GPU tooling')
        labels = {'app.kubernetes.io/name': 'colloq-nvidia-device-plugin'}
        plugin = resource('DaemonSet', 'colloq-nvidia-device-plugin', {
            'selector': {'matchLabels': labels}, 'template': {'metadata': {'labels': labels}, 'spec': {
                'runtimeClassName': 'nvidia', 'automountServiceAccountToken': False,
                'imagePullSecrets': [{'name': 'colloq-registry'}],
                'containers': [{'name': 'plugin', 'image': gpu['devicePluginImage'],
                    'args': ['--fail-on-init-error=true'], 'env': [
                        {'name': 'NVIDIA_VISIBLE_DEVICES', 'value': 'all'},
                        {'name': 'NVIDIA_DRIVER_CAPABILITIES', 'value': 'compute,utility'}],
                    'securityContext': {'allowPrivilegeEscalation': False, 'capabilities': {'drop': ['ALL']}},
                    'resources': {'requests': {'cpu': '50m', 'memory': '64Mi'}, 'limits': {'cpu': '500m', 'memory': '256Mi'}},
                    'volumeMounts': [{'name': 'device-plugins', 'mountPath': '/var/lib/kubelet/device-plugins'}]}],
                'volumes': [{'name': 'device-plugins', 'hostPath': {'path': '/var/lib/kubelet/device-plugins', 'type': 'Directory'}}]}}})
        plugin['metadata']['namespace'] = 'kube-system'
        print(json.dumps({'apiVersion': 'v1', 'kind': 'List', 'items': [
            resource('RuntimeClass', 'nvidia', handler='nvidia'), plugin]}))
    elif args.command == 'gpu-smoke':
        env = next((e for e in value['catalog']['environments'] if e['gpu'] and e.get('current', True)), None)
        env = env or next((e for e in value['catalog']['environments'] if e['gpu']), None)
        require(env, 'this release has no GPU environment')
        print(json.dumps(resource('Pod', 'colloq-gpu-check', {
            'restartPolicy': 'Never', 'runtimeClassName': 'nvidia', 'automountServiceAccountToken': False,
            'imagePullSecrets': [{'name': 'colloq-registry'}], 'activeDeadlineSeconds': 180,
            'securityContext': {'runAsNonRoot': True, 'runAsUser': 1000, 'runAsGroup': 1000,
                'seccompProfile': {'type': 'RuntimeDefault'}},
            'containers': [{'name': 'cuda', 'image': env['image'],
                'command': ['python', '-c', 'import torch; assert torch.cuda.is_available(); x=torch.ones(8,device="cuda"); assert x.sum().item()==8; torch.cuda.synchronize(); print(torch.cuda.get_device_name(0))'],
                'securityContext': {'allowPrivilegeEscalation': False, 'readOnlyRootFilesystem': True, 'capabilities': {'drop': ['ALL']}},
                'resources': {'requests': {'cpu': '100m', 'memory': '256Mi'}, 'limits': {'cpu': '1', 'memory': '2Gi', 'nvidia.com/gpu': 1}},
                'volumeMounts': [{'name': 'tmp', 'mountPath': '/tmp'}]}],
            'volumes': [{'name': 'tmp', 'emptyDir': {'sizeLimit': '256Mi'}}]})))
    elif args.command == 'prepull':
        images = list(dict.fromkeys([value['appImage'], value['runtimeImage']] + [e['image'] for e in value['catalog']['environments']]))
        containers = [{'name': f'image-{i}', 'image': img, 'imagePullPolicy': 'IfNotPresent',
            'command': ['sh', '-c', 'exit 0'], 'securityContext': {'allowPrivilegeEscalation': False,
                'readOnlyRootFilesystem': True, 'capabilities': {'drop': ['ALL']}},
            'resources': {'requests': {'cpu': '10m', 'memory': '16Mi'}, 'limits': {'cpu': '100m', 'memory': '64Mi'}}}
            for i, img in enumerate(images)]
        pod = resource('Pod', 'colloq-image-check', {'restartPolicy': 'Never', 'automountServiceAccountToken': False,
            'securityContext': {'runAsNonRoot': True, 'runAsUser': 1000, 'runAsGroup': 1000,
                'seccompProfile': {'type': 'RuntimeDefault'}}, 'imagePullSecrets': [{'name': 'colloq-registry'}],
            'initContainers': containers[:-1], 'containers': containers[-1:]})
        print(json.dumps(pod))
    elif args.command == 'config':
        allowed = {'UI_LANGUAGE', 'PUBLIC_URL', 'ADMIN_EMAIL', 'INSTITUTION', 'OPEN_SEMINAR_CREATION',
            'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'AI_PROVIDER', 'AI_REASONING',
            'SESSION_SECRET', 'TZ', 'MAX_UPLOAD_MB', 'MAX_SESSION_MB', 'COUNCIL_COPY_MB'}
        settings = {k: v for k, v in read_env(args.env_file).items() if k in allowed} if args.env_file else {}
        print(json.dumps(resource('Secret', 'colloq-app-config', type='Opaque', stringData=settings)))
    else:
        print('valid release ' + value['version'])


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError) as error:
        print('release: ' + str(error), file=sys.stderr)
        sys.exit(1)
