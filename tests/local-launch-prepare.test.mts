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
 * То же самое, но у установленного colloq: приложение отдельно, состояние
 * отдельно, и своё окружение преподавателя лежит во втором каталоге.
 *
 * Make здесь нет вовсе (его нет и на машине преподавателя), поэтому сборку
 * изображает сам docker, и он читает список пакетов ИЗ КОНТЕКСТА — ровно так,
 * как это делает `COPY environments/${KERNEL_ENV}.txt` в kernel/Dockerfile.
 * Значит, проверка отвечает на настоящий вопрос: попало ли своё окружение в то
 * место, откуда docker его заберёт.
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

test('своё окружение из каталога состояния собирается у установленного colloq', async () => {
  const f = distFixture()
  try {
    fs.mkdirSync(path.join(f.home, 'environments'), { recursive: true })
    fs.writeFileSync(path.join(f.home, 'environments/mine.txt'), '# colloq: from base\nstatsmodels')
    await f.run()
    // Родитель привезён с приложением, ребёнок заведён преподавателем; docker
    // прочитал оба из одного контекста.
    assert.deepEqual(f.builds(), ['base numpy==1', 'mine # colloq: from base|statsmodels'])
    // Повторный запуск ничего не пересобирает: склейка сохраняет время правки.
    await f.run()
    assert.equal(f.builds().length, 2)
    // Правка своего списка доезжает до сборки, привезённый родитель остаётся.
    fs.appendFileSync(path.join(f.home, 'environments/mine.txt'), '\nseaborn')
    await f.run()
    assert.deepEqual(f.builds().slice(2), ['mine # colloq: from base|statsmodels|seaborn'])
  } finally {
    f.close()
  }
})

test('своё имя перебивает привезённое, а без своих окружений ничего не копируется', async () => {
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
 * Рабочее дерево, у которого своё COLLOQ_HOME: Makefile рядом есть, а окружение
 * преподавателя лежит во втором каталоге.
 *
 * Это тот самый зазор между двумя развилками. Склейка каталогов стоит по
 * «home === root», а сборщик выбирался по dist — и здесь они расходились: make
 * читает $(ENV_DIR) рядом с собой и про <home>/environments не знает вовсе.
 * Занятие падало на «Нет kernel/environments/mine.txt», а если имя совпало с
 * привезённым, молча собирался ПРИВЕЗЁННЫЙ список под правильным именем.
 *
 * Поэтому make здесь настоящий (на машине с исходниками он есть) и записывает
 * каждый свой вызов: пустой список вызовов — половина проверки, вторая
 * половина — что docker собрал из склеенного контекста то, что человек написал.
 */
function splitFixture(kernelEnv = 'mine') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-split-'))
  const root = path.join(base, 'tree'),
    home = path.join(base, 'home')
  for (const dir of [path.join(base, 'bin'), path.join(root, 'kernel/environments'), home])
    fs.mkdirSync(dir, { recursive: true })
  // Makefile на месте — именно поэтому «дистрибутив ли это» здесь не ответ.
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
  // Цель env-build читает лист рядом с Makefile и ни про какой контекст сборки
  // не знает — здесь это сказано абсолютным путём в дерево приложения.
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

test('в рабочем дереве с COLLOQ_HOME своё окружение собирается, а make не зовётся', async () => {
  const f = splitFixture()
  try {
    fs.mkdirSync(path.join(f.home, 'environments'), { recursive: true })
    fs.writeFileSync(path.join(f.home, 'environments/mine.txt'), '# colloq: from base\nstatsmodels')
    await f.run()
    assert.deepEqual(f.makeCalls(), [], 'make не видит <home>/environments — звать его нельзя')
    assert.deepEqual(f.builds(), ['base numpy==1', 'mine # colloq: from base|statsmodels'])
  } finally {
    f.close()
  }
})

test('своё имя перебивает привезённое и в рабочем дереве, а не собирается чужой лист', async () => {
  const f = splitFixture('base')
  try {
    fs.mkdirSync(path.join(f.home, 'environments'), { recursive: true })
    fs.writeFileSync(path.join(f.home, 'environments/base.txt'), 'numpy==9')
    await f.run()
    assert.deepEqual(f.makeCalls(), [])
    assert.deepEqual(f.builds(), ['base numpy==9'], 'собран свой список, а не привезённый')
  } finally {
    f.close()
  }
})

test('без своих окружений рабочее дерево по-прежнему собирает целью env-build', async () => {
  const f = splitFixture('base')
  try {
    await f.run()
    // Склеивать нечего, корень сборки и есть корень приложения — значит make
    // читает ровно тот лист, из которого собирали бы руками.
    assert.deepEqual(f.makeCalls(), ['base'])
    assert.deepEqual(f.builds(), [], 'docker звали только за inspect')
  } finally {
    f.close()
  }
})
