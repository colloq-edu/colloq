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
    await assert.rejects(f.run(), /sources changed during the build/)
    assert.equal(fs.readFileSync(marker, 'utf8'), original)
  } finally {
    f.close()
  }
})

/**
 * The same, but for an installed colloq: the app is in one place, the state
 * in another, and the teacher's custom environment lives in the second
 * directory.
 *
 * There is no Make here at all (the teacher's machine has none either), so the
 * build is played by docker itself, and it reads the package list FROM THE
 * CONTEXT — exactly as `COPY environments/${KERNEL_ENV}.txt` in
 * kernel/Dockerfile does. So the check answers the real question: did the
 * custom environment land where docker will pick it up.
 */
function distFixture(kernelEnv = 'mine') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-dist-'))
  const root = path.join(base, 'app'),
    home = path.join(base, 'home')
  for (const dir of [path.join(base, 'bin'), path.join(root, 'kernel/environments'), home])
    fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(root, '.colloq-dist.json'), '{"name":"colloq"}')
  fs.writeFileSync(path.join(root, 'kernel/Dockerfile'), 'FROM fake')
  fs.writeFileSync(path.join(root, 'kernel/requirements.txt'), 'jupyter')
  fs.writeFileSync(path.join(root, 'kernel/environments/base.txt'), 'numpy==1')
  fs.writeFileSync(path.join(base, 'images.json'), '{}')
  fs.writeFileSync(
    path.join(base, 'bin/docker'),
    `#!${process.execPath}
    const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
    const file=${JSON.stringify(path.join(base, 'images.json'))};
    if(process.argv[2]==='info')process.exit(0);
    const images=JSON.parse(fs.readFileSync(file,'utf8'));
    if(process.argv[2]==='build'){
      const name=process.argv[process.argv.indexOf('--build-arg')+1].split('=')[1];
      const context=process.argv.at(-1);
      const source=fs.readFileSync(path.join(context,'environments',name+'.txt'),'utf8');
      fs.appendFileSync(${JSON.stringify(path.join(base, 'builds'))},name+' '+source.replace(/\\n/g,'|')+'\\n');
      images[name]={Id:crypto.createHash('sha256').update(source).digest('hex'),Created:new Date().toISOString()};
      fs.writeFileSync(file,JSON.stringify(images));
      process.exit(0);
    }
    const image=images[process.argv.at(-1).split(':').at(-1)];
    if(!image)process.exit(1);process.stdout.write(JSON.stringify([image]));`,
    { mode: 0o755 },
  )
  const options = parseLaunchArgs(['dev', '--no-open'])
  const config = launchConfig(
    root,
    options,
    {
      ...process.env,
      PATH: path.join(base, 'bin') + ':' + process.env.PATH,
      KERNEL_ENV: kernelEnv,
    },
    home,
  )
  return {
    base,
    root,
    home,
    config,
    run: () => prepare(config, options, new Processes(root, config.env), () => false),
    builds: () =>
      fs.existsSync(path.join(base, 'builds'))
        ? fs.readFileSync(path.join(base, 'builds'), 'utf8').trim().split('\n')
        : [],
    close: () => fs.rmSync(base, { recursive: true, force: true }),
  }
}

test('a custom environment from the state directory is built for an installed colloq', async () => {
  const f = distFixture()
  try {
    fs.mkdirSync(path.join(f.home, 'environments'), { recursive: true })
    fs.writeFileSync(path.join(f.home, 'environments/mine.txt'), '# colloq: from base\nstatsmodels')
    await f.run()
    // The parent came with the app, the child was created by the teacher;
    // docker read both from one context.
    assert.deepEqual(f.builds(), ['base numpy==1', 'mine # colloq: from base|statsmodels'])
    // A second run rebuilds nothing: the merge keeps the modification time.
    await f.run()
    assert.equal(f.builds().length, 2)
    // An edit to the custom list reaches the build, the bundled parent stays.
    fs.appendFileSync(path.join(f.home, 'environments/mine.txt'), '\nseaborn')
    await f.run()
    assert.deepEqual(f.builds().slice(2), ['mine # colloq: from base|statsmodels|seaborn'])
  } finally {
    f.close()
  }
})

test('a custom name overrides the bundled one, and without custom environments nothing is copied', async () => {
  const f = distFixture('base')
  try {
    await f.run()
    assert.deepEqual(f.builds(), ['base numpy==1'])
    assert.ok(!fs.existsSync(path.join(f.home, '.colloq/kernel-build')))
  } finally {
    f.close()
  }
  const g = distFixture()
  try {
    fs.mkdirSync(path.join(g.home, 'environments'), { recursive: true })
    fs.writeFileSync(path.join(g.home, 'environments/base.txt'), 'numpy==9')
    fs.writeFileSync(path.join(g.home, 'environments/mine.txt'), '# colloq: from base\nplotly')
    await g.run()
    assert.deepEqual(g.builds(), ['base numpy==9', 'mine # colloq: from base|plotly'])
  } finally {
    g.close()
  }
})

/**
 * A working tree with its own COLLOQ_HOME: there is a Makefile next to it,
 * and the teacher's environment lives in the second directory.
 *
 * This is exactly the gap between two forks. Merging the directories keyed on
 * "home === root", while the builder was chosen by dist — and here they
 * disagreed: make reads $(ENV_DIR) next to itself and knows nothing about
 * <home>/environments. The class failed on "No kernel/environments/mine.txt",
 * and if the name matched a bundled one, the BUNDLED list was silently built
 * under the right name.
 *
 * So make is real here (a machine with the sources has it) and records every
 * call it gets: an empty call list is half of the check, the other half is
 * that docker built from the merged context what the person wrote.
 */
function splitFixture(kernelEnv = 'mine') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-split-'))
  const root = path.join(base, 'tree'),
    home = path.join(base, 'home')
  for (const dir of [path.join(base, 'bin'), path.join(root, 'kernel/environments'), home])
    fs.mkdirSync(dir, { recursive: true })
  // The Makefile is in place — which is exactly why "is this a distribution"
  // is not the answer here.
  fs.writeFileSync(path.join(root, 'Makefile'), 'env-build:\n\t@true\n')
  fs.writeFileSync(path.join(root, 'kernel/Dockerfile'), 'FROM fake')
  fs.writeFileSync(path.join(root, 'kernel/requirements.txt'), 'jupyter')
  fs.writeFileSync(path.join(root, 'kernel/environments/base.txt'), 'numpy==1')
  fs.writeFileSync(path.join(base, 'images.json'), '{}')
  const images = JSON.stringify(path.join(base, 'images.json'))
  fs.writeFileSync(
    path.join(base, 'bin/docker'),
    `#!${process.execPath}
    const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
    if(process.argv[2]==='info')process.exit(0);
    const images=JSON.parse(fs.readFileSync(${images},'utf8'));
    if(process.argv[2]==='build'){
      const name=process.argv[process.argv.indexOf('--build-arg')+1].split('=')[1];
      const context=process.argv.at(-1);
      const source=fs.readFileSync(path.join(context,'environments',name+'.txt'),'utf8');
      fs.appendFileSync(${JSON.stringify(path.join(base, 'builds'))},name+' '+source.replace(/\\n/g,'|')+'\\n');
      images[name]={Id:crypto.createHash('sha256').update(source).digest('hex'),Created:new Date().toISOString()};
      fs.writeFileSync(${images},JSON.stringify(images));
      process.exit(0);
    }
    const image=images[process.argv.at(-1).split(':').at(-1)];
    if(!image)process.exit(1);process.stdout.write(JSON.stringify([image]));`,
    { mode: 0o755 },
  )
  // The env-build target reads the list next to the Makefile and knows nothing
  // about any build context — here that is spelled out as an absolute path
  // into the app tree.
  fs.writeFileSync(
    path.join(base, 'bin/make'),
    `#!${process.execPath}
    const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
    const name=process.argv.find(v=>v.startsWith('NAME=')).slice(5);
    fs.appendFileSync(${JSON.stringify(path.join(base, 'make-calls'))},name+'\\n');
    const source=fs.readFileSync(path.join(${JSON.stringify(root)},'kernel/environments',name+'.txt'),'utf8');
    const images=JSON.parse(fs.readFileSync(${images},'utf8'));
    images[name]={Id:crypto.createHash('sha256').update(source).digest('hex'),Created:new Date().toISOString()};
    fs.writeFileSync(${images},JSON.stringify(images));`,
    { mode: 0o755 },
  )
  const options = parseLaunchArgs(['dev', '--no-open'])
  const config = launchConfig(
    root,
    options,
    {
      ...process.env,
      PATH: path.join(base, 'bin') + ':' + process.env.PATH,
      KERNEL_ENV: kernelEnv,
    },
    home,
  )
  const lines = (name: string): string[] =>
    fs.existsSync(path.join(base, name))
      ? fs.readFileSync(path.join(base, name), 'utf8').trim().split('\n')
      : []
  return {
    base,
    root,
    home,
    config,
    run: () => prepare(config, options, new Processes(root, config.env), () => false),
    builds: () => lines('builds'),
    makeCalls: () => lines('make-calls'),
    close: () => fs.rmSync(base, { recursive: true, force: true }),
  }
}

test('in a working tree with COLLOQ_HOME a custom environment is built and make is not called', async () => {
  const f = splitFixture()
  try {
    fs.mkdirSync(path.join(f.home, 'environments'), { recursive: true })
    fs.writeFileSync(path.join(f.home, 'environments/mine.txt'), '# colloq: from base\nstatsmodels')
    await f.run()
    assert.deepEqual(f.makeCalls(), [], 'make does not see <home>/environments — it must not be called')
    assert.deepEqual(f.builds(), ['base numpy==1', 'mine # colloq: from base|statsmodels'])
  } finally {
    f.close()
  }
})

test('a custom name overrides the bundled one in a working tree too, instead of building the other list', async () => {
  const f = splitFixture('base')
  try {
    fs.mkdirSync(path.join(f.home, 'environments'), { recursive: true })
    fs.writeFileSync(path.join(f.home, 'environments/base.txt'), 'numpy==9')
    await f.run()
    assert.deepEqual(f.makeCalls(), [])
    assert.deepEqual(f.builds(), ['base numpy==9'], 'the custom list is built, not the bundled one')
  } finally {
    f.close()
  }
})

test('without custom environments a working tree still builds with the env-build target', async () => {
  const f = splitFixture('base')
  try {
    await f.run()
    // There is nothing to merge, the build root is the app root — so make
    // reads exactly the list one would build from by hand.
    assert.deepEqual(f.makeCalls(), ['base'])
    assert.deepEqual(f.builds(), [], 'docker was called only for inspect')
  } finally {
    f.close()
  }
})
