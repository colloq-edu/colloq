#!/usr/bin/env python3
"""Write one release's images and kernel catalog into the Helm chart.

The chart job of publish.yml runs this with the digests the image jobs pushed,
taken from their outputs: nothing is built, pulled or looked up here. It writes
them into the chart as its defaults (values.yaml, plus version and appVersion
in Chart.yaml) and writes the same release values on their own into the file
given by --output, values-<version>.yaml on the GitHub Release: what a registry
mirror copies by digest, and what a GitOps repository diffs between releases.

The catalog entries come from scripts/release-build.py (chain and
catalog_environment), the code that writes release.json's catalog, so one
release has one package list and one GPU flag per environment whichever way it
is installed.

values.yaml is edited in place, not regenerated: it is the chart's reference
(every value explained in a comment next to it), and the standard library has
no YAML parser to round-trip it with. So the edit is narrow. Each path is found
by its keys in block style and only its value is replaced; a path that is
missing is a refusal, never a guess where it might go: a chart that moved its
values is caught at the release, not in a customer's cluster.

Usage (see publish.yml):
  python3 scripts/chart-values.py --version 0.10.0 \\
    --app-image ghcr.io/o/colloq-app@sha256:... --runtime-image ghcr.io/o/colloq-runtime@sha256:... \\
    --kernel-images '{"base": "ghcr.io/o/colloq-kernel@sha256:...", ...}' \\
    --chart deploy/helm/colloq --output out/values-0.10.0.yaml
The release values are also printed to stdout as one line of JSON.
"""
import argparse
import importlib.util
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('release_build', ROOT / 'scripts/release-build.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
release = builder.release

# The SemVer subset scripts/version.mts accepts. It is the chart version as well,
# and Helm wants exactly SemVer there.
VERSION = re.compile(r'^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?$')

# The paths this release owns in values.yaml, all of which must exist in the
# chart. The chart renders the app and the broker as
# <image.registry>/<image.*.repository>@<digest> (global.imageRegistry replacing
# the registry), and takes the catalog's images as full references.
REQUIRED = [('image', 'registry'),
            ('image', 'app', 'repository'), ('image', 'app', 'digest'),
            ('image', 'runtime', 'repository'), ('image', 'runtime', 'digest'),
            ('catalog', 'defaultEnvironment'), ('catalog', 'environments')]


def pinned(reference, what):
    """(repository, digest) of a registry reference pinned by sha256; the same grammar the broker takes."""
    if not release.image_reference(reference):
        raise ValueError(f'{what} must be a registry image pinned by sha256 digest, got {reference!r}')
    repository, digest = reference.split('@', 1)
    return repository, digest


def split_registry(repository, what):
    """('ghcr.io', 'colloq-edu/colloq-app') of ghcr.io/colloq-edu/colloq-app, by Docker's rule:
    the first component is a registry when it has a dot or a port, or is localhost."""
    first, _, path = repository.partition('/')
    if not path or not ('.' in first or ':' in first or first == 'localhost'):
        raise ValueError(f'{what} names no registry: {repository}')
    return first, path


def kernel_catalog(images, default):
    """The catalog: every published environment, parents first, by release-build.py's own code."""
    if not isinstance(images, dict) or not images:
        raise ValueError('--kernel-images must be a JSON object of environment name -> pinned image')
    ordered = {}
    for name in images:
        try:
            builder.chain(name, ordered, set())
        except FileNotFoundError:
            raise ValueError(f'kernel/environments/{name}.txt does not exist at this commit') from None
    missing = [name for name in ordered if name not in images]
    if missing:
        raise ValueError('no published image for ' + ', '.join(missing) +
                         ', which another environment is built on; the kernels job publishes parents first')
    flags, entries = {}, []
    for name, environment in ordered.items():
        pinned(images[name], f'the image of environment {name}')
        entry = builder.catalog_environment(name, environment, images[name], flags)
        # One revision per environment in a fresh catalog, which the app and the
        # broker take as the current one; the chart's catalog has no such field.
        del entry['current']
        if len(entry['packages']) > 2000 or any(release.string_length(p) > 512 for p in entry['packages']):
            raise ValueError(f'the package list of {name} is longer than the catalog allows')
        entries.append(entry)
    if default not in ordered:
        raise ValueError(f'the default environment {default} is not among the published ones: {", ".join(ordered)}')
    return {'defaultEnvironment': default, 'environments': entries}


def release_values(app_image, runtime_image, kernel_images, default):
    app_repository, app_digest = pinned(app_image, '--app-image')
    runtime_repository, runtime_digest = pinned(runtime_image, '--runtime-image')
    registry, app_path = split_registry(app_repository, '--app-image')
    runtime_registry, runtime_path = split_registry(runtime_repository, '--runtime-image')
    if runtime_registry != registry:
        # One image.registry serves both in the chart.
        raise ValueError(f'the app and the broker come from different registries: {registry}, {runtime_registry}')
    return {'image': {'registry': registry,
                      'app': {'repository': app_path, 'digest': app_digest},
                      'runtime': {'repository': runtime_path, 'digest': runtime_digest}},
            'catalog': kernel_catalog(kernel_images, default)}


# ---------------------------------------------------------------- YAML out

def scalar(value):
    # JSON's double-quoted strings are YAML's, so a string never turns into a
    # number, a boolean or a null on the way (a digest, a version like 1.10).
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if value is None:
        return 'null'
    if isinstance(value, dict) and not value:
        return '{}'
    if isinstance(value, list) and not value:
        return '[]'
    if isinstance(value, (dict, list)):
        raise TypeError('not a scalar')
    return json.dumps(value, ensure_ascii=False)


def emit(value, indent):
    """Block-style YAML lines for nested dicts and lists of the values above."""
    pad, lines = ' ' * indent, []
    if isinstance(value, dict):
        for key, item in value.items():
            if isinstance(item, (dict, list)) and item:
                lines.append(f'{pad}{key}:')
                lines.extend(emit(item, indent + 2))
            else:
                lines.append(f'{pad}{key}: {scalar(item)}')
    else:
        for item in value:
            if isinstance(item, dict) and item:
                first, *rest = emit(item, indent + 2)
                lines.append(f'{pad}- {first.lstrip()}')
                lines.extend(rest)
            else:
                lines.append(f'{pad}- {scalar(item)}')
    return lines


# ------------------------------------------------------- YAML edited in place

KEY = re.compile(r'''^(?P<indent> *)(?P<key>[A-Za-z_][\w.-]*|"[^"\\]*"|'[^']*')[ \t]*:(?=[ \t]|$)(?P<rest>.*)$''')
SEQUENCE_ITEM = re.compile(r'^ *-(?:[ \t]|$)')


def meaningful(line):
    text = line.strip()
    return bool(text) and not text.startswith('#')


def indent_of(line):
    return len(line) - len(line.lstrip(' '))


def key_name(raw):
    return raw[1:-1] if raw[:1] in '"\'' else raw


def children(lines, start, end, parent_indent):
    """(key, line) of the mapping entries directly inside lines[start:end].

    Only lines at the first child's indent count, so the content of a block
    scalar or of a deeper mapping, always indented further, is never taken for
    a key of this level.
    """
    found, child = [], None
    for i in range(start, end):
        line = lines[i]
        if not meaningful(line):
            continue
        indent = indent_of(line)
        if indent <= parent_indent:
            break
        if child is None:
            child = indent
        match = KEY.match(line) if indent == child else None
        if match:
            found.append((key_name(match['key']), i))
    return found


def extent(lines, at):
    """End (exclusive) of the value of the key on line `at`: the lines indented
    further, or a block sequence at the key's own indent. Comments and blank
    lines after the last of them stay with whatever follows."""
    indent, end = indent_of(lines[at]), at + 1
    for j in range(at + 1, len(lines)):
        line = lines[j]
        if not meaningful(line):
            continue
        if indent_of(line) > indent or (indent_of(line) == indent and SEQUENCE_ITEM.match(line)):
            end = j + 1
        else:
            break
    return end


def locate(lines, path):
    start, end, parent, at = 0, len(lines), -1, None
    for depth, key in enumerate(path):
        hits = [line for name, line in children(lines, start, end, parent) if name == key]
        where = '.'.join(path[:depth + 1])
        if not hits:
            raise LookupError(where)
        if len(hits) > 1:
            raise ValueError(f'values.yaml sets {where} twice')
        at = hits[0]
        start, end, parent = at + 1, extent(lines, at), indent_of(lines[at])
    return at, end


def trailing_comment(rest):
    """The `# ...` after a key's inline value, which stays where it was."""
    text = rest.strip()
    if not text or text.startswith('#'):
        return text
    if text[0] in '"\'':
        quote, k = text[0], 1
        while k < len(text):
            if quote == '"' and text[k] == '\\':
                k += 2
                continue
            if text[k] == quote:
                if quote == "'" and text[k + 1:k + 2] == "'":
                    k += 2
                    continue
                break
            k += 1
        after = text[k + 1:]
        hash_at = after.find('#')
        return after[hash_at:].strip() if hash_at >= 0 else ''
    match = re.search(r'\s#', text)
    return text[match.start():].strip() if match else ''


def inline_value(rest):
    """A key's inline scalar without its comment and quotes."""
    text, comment = rest.strip(), trailing_comment(rest)
    if comment:
        text = text[:len(text) - len(comment)].strip()
    return key_name(text)


def with_comment(line, comment):
    return f'{line}  {comment}' if comment else line


def set_scalar(lines, path, value):
    at, end = locate(lines, path)
    if any(meaningful(line) for line in lines[at + 1:end]):
        raise ValueError(f'values.yaml has a block under {".".join(path)}, where the release writes one value')
    match = KEY.match(lines[at])
    lines[at] = with_comment(f"{match['indent']}{match['key']}: {scalar(value)}", trailing_comment(match['rest']))


def set_list(lines, path, items):
    at, end = locate(lines, path)
    match = KEY.match(lines[at])
    comment = trailing_comment(match['rest'])
    if not items:
        lines[at:end] = [with_comment(f"{match['indent']}{match['key']}: []", comment)]
        return
    # Comments right under the key describe the list and stay; the old entries,
    # and anything written between them, go with them.
    first = next((j for j in range(at + 1, end) if meaningful(lines[j])), end)
    lines[first:end] = emit(items, len(match['indent']) + 2)
    lines[at] = with_comment(f"{match['indent']}{match['key']}:", comment)


def write_values(text, values):
    lines = text.split('\n')
    try:
        for path in REQUIRED[:-1]:
            node = values
            for key in path:
                node = node[key]
            set_scalar(lines, path, node)
        set_list(lines, REQUIRED[-1], values['catalog']['environments'])
    except LookupError as missing:
        raise ValueError(f'the chart\'s values.yaml has no {missing.args[0]}: the chart and scripts/chart-values.py '
                         'disagree about where the release goes') from None
    written = '\n'.join(lines)
    # Read back through the same locator: a value that landed somewhere else, or
    # a path that no longer resolves once the file changed, stops here.
    again = written.split('\n')
    for path in REQUIRED[:-1]:
        at, _ = locate(again, path)
        node = values
        for key in path:
            node = node[key]
        if not KEY.match(again[at])['rest'].strip().startswith(scalar(node)):
            raise ValueError(f'{".".join(path)} did not read back as written')
    locate(again, REQUIRED[-1])
    return written


def write_chart_yaml(text, version):
    lines = text.split('\n')
    top = {}
    for i, line in enumerate(lines):
        match = KEY.match(line)
        if match and not match['indent']:
            top.setdefault(key_name(match['key']), i)
    if 'name' not in top or inline_value(KEY.match(lines[top['name']])['rest']) != 'colloq':
        raise ValueError('Chart.yaml must name the chart colloq: it is published as oci://ghcr.io/<owner>/charts/colloq')
    if 'version' not in top:
        raise ValueError('Chart.yaml has no version')
    # The chart version is the release version: one number for the chart, its
    # images and the app inside them.
    lines[top['version']] = f'version: {version}'
    if 'appVersion' in top:
        lines[top['appVersion']] = f'appVersion: "{version}"'
    else:
        lines.insert(top['version'] + 1, f'appVersion: "{version}"')
    return '\n'.join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--version', required=True, help='the release version, X.Y.Z[-rc.N], without the v')
    parser.add_argument('--app-image', required=True, help='colloq-app pinned by digest')
    parser.add_argument('--runtime-image', required=True, help='colloq-runtime pinned by digest')
    parser.add_argument('--kernel-images', required=True, help='JSON object: environment name -> pinned kernel image')
    parser.add_argument('--default-environment', default='base')
    parser.add_argument('--chart', help='the chart directory to write the release into (values.yaml, Chart.yaml)')
    parser.add_argument('--output', required=True, help='where to write the release values on their own')
    args = parser.parse_args()
    if not VERSION.fullmatch(args.version):
        parser.error(f'--version {args.version!r} is not a release version (X.Y.Z or X.Y.Z-rc.N, without the v)')
    try:
        images = json.loads(args.kernel_images)
    except json.JSONDecodeError:
        parser.error('--kernel-images is not JSON')
    values = release_values(args.app_image, args.runtime_image, images, args.default_environment)
    if args.chart:
        chart = pathlib.Path(args.chart)
        # Both files are checked before either is written: a refusal leaves the chart as it was.
        new_values = write_values((chart / 'values.yaml').read_text(encoding='utf-8'), values)
        new_chart = write_chart_yaml((chart / 'Chart.yaml').read_text(encoding='utf-8'), args.version)
        (chart / 'values.yaml').write_text(new_values, encoding='utf-8')
        (chart / 'Chart.yaml').write_text(new_chart, encoding='utf-8')
    header = [f'# Colloq {args.version}: the images and the kernel catalog this release published, by digest.',
              '# The chart of the same version carries these values as its defaults; this file lists them',
              '# on their own, for a registry mirror to copy the images and for a diff between releases.',
              '# Written by publish.yml (scripts/chart-values.py).']
    pathlib.Path(args.output).write_text('\n'.join(header + emit(values, 0)) + '\n', encoding='utf-8')
    print(json.dumps(values, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError) as error:
        print('chart-values: ' + str(error), file=sys.stderr)
        sys.exit(1)
