import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const script = fileURLToPath(new URL('../scripts/runtime-backup.py', import.meta.url))
test('portable shell restore resets retired services only after files restore and before marker finalization', () => {
  const result = spawnSync(
    'python3',
    [
      '-c',
      `import importlib.util,pathlib,tempfile,sqlite3,json,types,sys,shutil,subprocess,os
spec=importlib.util.spec_from_file_location('recovery',sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp); source=root/'source'; target=root/'target'; source.mkdir(); target.mkdir()
 for name in ('data','workspace','secrets'): (source/name).mkdir(); (target/name).mkdir()
 (source/'workspace'/'restored-room').write_text('restored')
 with sqlite3.connect(source/'data'/'colloq.db') as c: c.execute('create table x(value)')
 release=root/'release.json'; release.write_text(json.dumps(dict(dataSchemaVersion=1,compatibleDataSchemaVersions=[1],catalog={})))
 archive=root/'backup.tar.gz'; m.backup(types.SimpleNamespace(root=str(source),release=str(release),output=str(archive),mode='live',quiesced=False,name=''))
 scripts=root/'scripts'; scripts.mkdir()
 for name in ('restore.sh','runtime-backup.py','state-lock.py'): shutil.copy2(pathlib.Path(sys.argv[1]).parent/name,scripts/name)
 (target/'tombstone').write_text('retired-room')
 (scripts/'cluster.sh').write_text('''#!/usr/bin/env bash
set -euo pipefail
echo "$1" >> "$COLLOQ_STATE_DIR/events"
if [ "$1" = restore-services ]; then
  test -f "$COLLOQ_STATE_DIR/.restore-in-progress"
  test -f "$COLLOQ_STATE_DIR/workspace/restored-room"
  if [ "$FAIL_RESET" = 1 ]; then exit 99; fi
  python3 -c 'import json,os; from pathlib import Path; p=Path(os.environ["COLLOQ_STATE_DIR"]); assert json.loads((p/".restore-in-progress").read_text())["phase"]=="files-restored"; (p/"tombstone").unlink()'
fi
''')
 env={**os.environ,'COLLOQ_STATE_DIR':str(target),'NAME':'','FAIL_RESET':'0'}
 command=['bash',str(scripts/'restore.sh'),'--archive',str(archive),'--release',str(release)]
 failed=subprocess.run(command+['--replace'],env={**env,'FAIL_RESET':'1'},capture_output=True,text=True)
 assert failed.returncode==99, failed.stdout+failed.stderr
 assert (target/'tombstone').exists()
 assert json.loads((target/'.restore-in-progress').read_text())['phase']=='files-restored'
 completed=subprocess.run(command+['--recover'],env=env,capture_output=True,text=True)
 assert completed.returncode==0, completed.stdout+completed.stderr
 assert (target/'events').read_text()=='stop\\nrestore-services\\nstop\\nrestore-services\\n'
 assert not (target/'tombstone').exists()
 assert not (target/'.restore-in-progress').exists()
`,
      script,
    ],
    { encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stderr)
})
test('fsync failure after a rename cannot clear the interrupted-restore marker', () => {
  const result = spawnSync(
    'python3',
    [
      '-c',
      `import importlib.util,pathlib,tempfile,sqlite3,json,types,sys
spec=importlib.util.spec_from_file_location('recovery',sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp); source=root/'source'; target=root/'target'; source.mkdir(); target.mkdir()
 for name in ('data','workspace','secrets'): (source/name).mkdir(); (target/name).mkdir()
 (target/'data'/'old').write_text('old')
 with sqlite3.connect(source/'data'/'colloq.db') as c: c.execute('create table x(value)')
 release=root/'release.json'; release.write_text(json.dumps(dict(dataSchemaVersion=1,compatibleDataSchemaVersions=[1],catalog={})))
 archive=root/'backup.tar.gz'; m.backup(types.SimpleNamespace(root=str(source),release=str(release),output=str(archive),mode='live',quiesced=False,name=''))
 real=m.sync_directory
 def fail(directory):
  if pathlib.Path(directory)==target and not (target/'data').exists(): raise OSError('injected fsync failure')
  return real(directory)
 m.sync_directory=fail
 try: m.restore(types.SimpleNamespace(root=str(target),release=str(release),archive=str(archive),name='',replace=True,recover=False))
 except (OSError,ValueError): pass
 else: raise AssertionError('restore unexpectedly succeeded')
 assert (target/'.restore-in-progress').exists(), 'marker incorrectly cleared after incomplete rollback'
`,
      script,
    ],
    { encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stderr)
})
test('interrupted tree replacement leaves a durable marker and requires validated explicit recovery', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-interrupted-'))
  const source = path.join(temp, 'source'),
    target = path.join(temp, 'target'),
    archive = path.join(temp, 'backup.tar.gz'),
    release = path.join(temp, 'release.json')
  const run = (...args: string[]) => spawnSync('python3', [script, ...args], { encoding: 'utf8' })
  try {
    for (const name of ['data', 'workspace', 'secrets']) {
      fs.mkdirSync(path.join(source, name), { recursive: true })
      fs.mkdirSync(path.join(target, name), { recursive: true })
    }
    fs.writeFileSync(path.join(source, 'workspace/new'), 'new')
    fs.writeFileSync(path.join(target, 'workspace/old'), 'old')
    fs.writeFileSync(path.join(target, 'data/prior'), 'prior')
    assert.equal(
      spawnSync('python3', [
        '-c',
        'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("create table x(value)"); c.commit()',
        path.join(source, 'data/colloq.db'),
      ]).status,
      0,
    )
    fs.writeFileSync(
      release,
      JSON.stringify({ dataSchemaVersion: 1, compatibleDataSchemaVersions: [1], catalog: {} }),
    )
    const backed = run(
      'backup',
      '--root',
      source,
      '--release',
      release,
      '--output',
      archive,
      '--mode',
      'live',
    )
    assert.equal(backed.status, 0, backed.stderr)
    const kill = spawnSync(
      'python3',
      [
        '-c',
        `import importlib.util,os,pathlib,sys,types
spec=importlib.util.spec_from_file_location('recovery',sys.argv[1]); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
original=pathlib.Path.rename
def interrupted(self,target):
 result=original(self,target)
 if pathlib.Path(target)==pathlib.Path(sys.argv[2])/'data':
  assert (pathlib.Path(sys.argv[2])/'.restore-in-progress').is_file()
  os._exit(90)
 return result
pathlib.Path.rename=interrupted
module.restore(types.SimpleNamespace(root=sys.argv[2],archive=sys.argv[3],release=sys.argv[4],name='',replace=True,recover=False))`,
        script,
        target,
        archive,
        release,
      ],
      { encoding: 'utf8' },
    )
    assert.equal(kill.status, 90, kill.stderr)
    const marker = path.join(target, '.restore-in-progress')
    assert.equal(fs.existsSync(marker), true)
    const refused = run(
      'restore',
      '--root',
      target,
      '--release',
      release,
      '--archive',
      archive,
      '--replace',
    )
    assert.notEqual(refused.status, 0)
    assert.match(refused.stderr, /recover|interrupted/)
    const recovered = run(
      'restore',
      '--root',
      target,
      '--release',
      release,
      '--archive',
      archive,
      '--recover',
    )
    assert.equal(recovered.status, 0, recovered.stderr)
    assert.equal(fs.existsSync(marker), false)
    assert.equal(fs.readFileSync(path.join(target, 'workspace/new'), 'utf8'), 'new')
    assert.equal(fs.existsSync(path.join(target, 'workspace/old')), false)
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(target, 'recovery/release.json'), 'utf8'))
        .dataSchemaVersion,
      1,
    )
    assert.ok(
      fs
        .readdirSync(target)
        .filter((name) => name.startsWith('replaced-'))
        .some((name) => fs.existsSync(path.join(target, name, 'data/prior'))),
    )
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})
