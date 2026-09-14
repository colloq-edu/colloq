import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { launchConfig, parseLaunchArgs } from '../cli/src/launch-config.js'
import { prepare } from '../cli/src/launch-prepare.js'
import { Processes } from '../cli/src/launch-process.js'

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-prepare-'))
  for (const dir of ['bin', 'kernel/environments'])
    fs.mkdirSync(path.join(root, dir), { recursive: true })
  fs.writeFileSync(path.join(root, 'kernel/Dockerfile'), 'FROM fake')
  fs.writeFileSync(path.join(root, 'kernel/requirements.txt'), 'jupyter')
  fs.writeFileSync(path.join(root, 'kernel/environments/base.txt'), 'numpy==1')
  fs.writeFileSync(
    path.join(root, 'kernel/environments/child.txt'),
    '# colloq: from base\npandas==1',
  )
  const imagesFile = path.join(root, 'images.json')
  const images = {
    base: { Id: 'base-original', Created: '2100-01-01T00:00:00Z' },
    child: { Id: 'child-original', Created: '2100-01-01T00:00:00Z' },
  }
  fs.writeFileSync(imagesFile, JSON.stringify(images))
  const executable = (name: string, source: string) =>
    fs.writeFileSync(path.join(root, 'bin', name), `#!${process.execPath}\n${source}\n`, {
      mode: 0o755,
    })
  executable(
    'docker',
    `const fs=require('node:fs');
    if(process.argv[2]==='info')process.exit(0);
    const name=process.argv.at(-1).split(':').at(-1);
    const image=JSON.parse(fs.readFileSync('images.json'))[name];
    if(!image)process.exit(1);process.stdout.write(JSON.stringify([image]));`,
  )
  // Like env-build, an explicitly requested environment rebuilds atop its
  // existing parent. Docker itself is deliberately never contacted.
  executable(
    'make',
    `const fs=require('node:fs'),crypto=require('node:crypto');
    const name=process.argv.find(v=>v.startsWith('NAME=')).slice(5);
    fs.appendFileSync('builds',name+'\\n');
    const images=JSON.parse(fs.readFileSync('images.json'));
    const source=fs.readFileSync('kernel/environments/'+name+'.txt','utf8');
    const parent=source.match(/# colloq: from (\\S+)/)?.[1];
    const Id=crypto.createHash('sha256').update(source+(parent?images[parent].Id:'')).digest('hex');
    images[name]={Id,Created:new Date().toISOString()};
    fs.writeFileSync('images.json',JSON.stringify(images));
    if(process.env.FAKE_EDIT_DURING_BUILD)fs.appendFileSync('kernel/environments/base.txt','\\nchanged-during-build');`,
  )
  const options = parseLaunchArgs(['dev', '--no-open'])
  const config = launchConfig(root, options, {
    ...process.env,
    PATH: path.join(root, 'bin') + ':' + process.env.PATH,
    KERNEL_ENV: 'child',
    COLLOQ_UNSAFE_DEV_FILES: '1',
  })
  const processes = new Processes(root, config.env)
  return {
    root,
    config,
    run: () => prepare(config, options, processes, () => false),
    builds: () =>
      fs.existsSync(path.join(root, 'builds'))
        ? fs.readFileSync(path.join(root, 'builds'), 'utf8').trim().split('\n')
        : [],
    close: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

test('changed parent rebuilds before its existing child and the resulting chain is reusable', async () => {
  const f = fixture()
  try {
    await f.run()
    assert.deepEqual(f.builds(), [])
    fs.writeFileSync(path.join(f.root, 'kernel/environments/base.txt'), 'numpy==2')
    await f.run()
    assert.deepEqual(f.builds(), ['base', 'child'])
    await f.run()
    assert.deepEqual(f.builds(), ['base', 'child'])
  } finally {
    f.close()
  }
})

test('changing only the child preserves its unchanged expensive parent image', async () => {
  const f = fixture()
  try {
    await f.run()
    fs.appendFileSync(path.join(f.root, 'kernel/environments/child.txt'), '\nscipy')
    await f.run()
    assert.deepEqual(f.builds(), ['child'])
    const images = JSON.parse(fs.readFileSync(path.join(f.root, 'images.json'), 'utf8'))
    assert.equal(images.base.Id, 'base-original')
  } finally {
    f.close()
  }
})

test('a replaced parent image invalidates the dependent child image', async () => {
  const f = fixture()
  try {
    await f.run()
    const images = JSON.parse(fs.readFileSync(path.join(f.root, 'images.json'), 'utf8'))
    images.base.Id = 'externally-replaced'
    fs.writeFileSync(path.join(f.root, 'images.json'), JSON.stringify(images))
    await f.run()
    assert.deepEqual(f.builds(), ['base', 'child'])
  } finally {
    f.close()
  }
})

test('source changes during a kernel build fail without marking the new sources current', async () => {
  const f = fixture()
  try {
    await f.run()
    const marker = path.join(f.root, '.colloq/kernel-child.json')
    const original = fs.readFileSync(marker, 'utf8')
    fs.appendFileSync(path.join(f.root, 'kernel/environments/child.txt'), '\nscipy')
    f.config.env.FAKE_EDIT_DURING_BUILD = '1'
    await assert.rejects(f.run(), /Исходники изменились во время сборки/)
    assert.equal(fs.readFileSync(marker, 'utf8'), original)
  } finally {
    f.close()
  }
})
