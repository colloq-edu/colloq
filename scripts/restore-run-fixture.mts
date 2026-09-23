// Test subprocess: establish isolation before loading any server module.
import '../tests/_env.mts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const [mode, selectedRoot] = process.argv.slice(2)
assert.equal(process.env.COLLOQ_RESTORE_DOCKER_TEST, '1', 'opt-in Docker fixture only')
assert.ok(mode === 'seed' || mode === 'run')
const root = path.resolve(selectedRoot ?? '')
assert.equal(fs.readFileSync(path.join(root, '.restore-smoke-root'), 'utf8'), 'colloq-restore-smoke-v1')
assert.equal(fs.realpathSync(root), root, 'fixture root must not be a symlink')
process.env.DATA_DIR = path.join(root, 'data')
process.env.WORKSPACE_DIR = path.join(root, 'workspace')
process.env.COMPETITION_BACKEND = 'docker'
delete process.env.DATA_HOST_DIR
delete process.env.WORKSPACE_HOST_DIR
const execute = promisify(execFile)
const docker = async (args: string[]) => (await execute('docker', args, {timeout:30_000,maxBuffer:4*1024*1024})).stdout.trim()
const hash = (body: Uint8Array | string) => createHash('sha256').update(body).digest('hex')
const { closeDatabase } = await import('../server/src/db.js')
const competitions = await import('../server/src/competitions/store.js')
const storage = await import('../server/src/competitions/storage.js')
const dependencies = await import('../server/src/dependencies/store.js')
const files = await import('../server/src/dependencies/files.js')
const { prepareDependencies } = await import('../server/src/dependencies/preparation.js')
const { competitionRunner, limitsFor } = await import('../server/src/competitions/runner-port.js')
await import('../server/src/competitions/docker-runner.js')

interface Fixture { competitionId: string; submissionId: string; imageDigest: string; bundleHash: string }
const fixturePath = path.join(root, 'data', 'restore-smoke.json')
// Like runner.ts's mount preparation, only the private fixture's read-only
// inputs are made readable by container UID 1000 on developer/CI host UIDs.
function readable(directory: string): void {
  fs.chmodSync(directory, 0o755)
  for (const name of fs.readdirSync(directory)) {
    const item = path.join(directory, name), stat = fs.lstatSync(item)
    assert.ok(!stat.isSymbolicLink())
    if (stat.isDirectory()) readable(item)
    else fs.chmodSync(item, 0o444)
  }
}

try {
  if (mode === 'seed') {
    const imageDigest = await docker(['image','inspect','--format','{{.Id}}','colloq-kernel:kaggle-base'])
    assert.match(imageDigest, /^sha256:[a-f0-9]{64}$/)
    const inventory = JSON.parse(await docker(['run','--rm','--pull=never','--network=none','--read-only','--entrypoint=python',imageDigest,'-I','-c',
      'import importlib.metadata as m,json,platform,sysconfig; print(json.dumps({"python":platform.python_version(),"abi":sysconfig.get_config_var("SOABI"),"packages":[{"name":d.metadata["Name"],"version":d.version} for d in m.distributions() if d.metadata["Name"]]}))']))
    assert.ok(!inventory.packages.some((p: {name:string}) => p.name.toLowerCase() === 'python-slugify'), 'fixture package must be absent from the base')
    const competition = competitions.createCompetition({slug:'restore-run',title:'Isolated restore smoke',blurb:'',description:'',environment:'kaggle-base',publicPercent:50,
      metric:{name:'MAE',direction:'lower',code:'def score(solution, submission):\n    return float((solution["target"] - submission["target"]).abs().mean())\n'},
      limits:{wallSeconds:90,memoryMb:1024,cpus:1,perDay:0}})!
    competitions.setCompetitionState(competition.id, 'live')
    const entrant = competitions.createEntrant('Restore fixture').entrant
    const revision = dependencies.putRevision({environmentName:'kaggle-base',imageDigest,pythonVersion:inventory.python,pythonAbi:inventory.abi,
      platform:await docker(['image','inspect','--format','{{.Os}}/{{.Architecture}}',imageDigest]),packages:inventory.packages,baseConstraintsHash:hash(JSON.stringify(inventory.packages))})
    dependencies.selectRevision(competition.id, revision.id)
    dependencies.setPolicy(competition.id, {enabled:true,maxDownloadBytes:8*1024*1024})
    const bundle = dependencies.createBundle(competition.id,entrant.id,revision.id,'python-slugify==8.0.4')
    assert.equal(dependencies.claimNextBundle()?.id, bundle.id)
    const prepared = await prepareDependencies({id:bundle.id,imageDigest,requirementsText:bundle.requirementsText,basePackages:revision.packages,
      workDir:files.freshStaging(bundle.id),maxDownloadBytes:8*1024*1024,maxInstalledBytes:32*1024*1024,wallSeconds:90,
      signal:AbortSignal.timeout(100_000),onProgress:update=>{dependencies.updateProgress(bundle.id,update); if(update.log) console.error(`[preparation ${update.state}] ${update.log}`)}})
    assert.match(prepared.lock,/--hash=sha256:/)
    assert.ok(prepared.packages.some(pkg=>pkg.name==='python-slugify'))
    assert.ok(prepared.packages.some(pkg=>pkg.name==='text-unidecode'))
    await files.publishBundle(bundle.id,prepared)
    assert.equal(dependencies.completeBundle(bundle.id,prepared),true)
    files.removeStaging(bundle.id)
    const notebook = Buffer.from(JSON.stringify({nbformat:4,nbformat_minor:5,metadata:{kernelspec:{name:'python3',display_name:'Python 3',language:'python'}},cells:[{
      cell_type:'code',metadata:{},execution_count:null,outputs:[],source:[
        'from pathlib import Path\n','from importlib.metadata import version\n','from slugify import slugify\n','import pandas as pd\n',
        'assert version("python-slugify") == "8.0.4"\n','assert slugify("Alpha One") == "alpha-one"\n',
        'assert {p.name for p in Path("/sys/class/net").iterdir()} == {"lo"}\n',
        'pd.read_csv("/data/sample_submission.csv").to_csv("submission.csv", index=False)\n',
      ]}]}))
    const submission = competitions.acceptSubmission({competitionId:competition.id,entrantId:entrant.id,fileName:'fixture.ipynb',bytes:notebook.length})
    dependencies.bindSubmission(submission.id,revision.id,bundle.id)
    storage.putSubmissionNotebook(competition.id,submission.id,notebook)
    storage.putOpenFile(competition.id,'sample_submission.csv',Buffer.from('id,target\n1,0\n2,0\n3,0\n4,0\n'))
    storage.putSecretFile(competition.id,'solution.csv',Buffer.from('id,target,Usage\n1,0,Public\n2,0,Public\n3,0,Private\n4,0,Private\n'))
    storage.putSecretFile(competition.id,'metric.py',Buffer.from(competition.metric.code))
    fs.writeFileSync(fixturePath,JSON.stringify({competitionId:competition.id,submissionId:submission.id,imageDigest,bundleHash:prepared.contentHash} satisfies Fixture))
  }
  const fixture: Fixture = JSON.parse(fs.readFileSync(fixturePath,'utf8'))
  const competition = competitions.getCompetition(fixture.competitionId)!
  const binding = dependencies.getBinding(fixture.submissionId)!
  assert.ok(binding.revision && binding.bundle)
  assert.equal(binding.revision.imageDigest, fixture.imageDigest)
  assert.equal(binding.bundle.contentHash, fixture.bundleHash)
  // Portable archives retain references, not image layers. The pinned image
  // must still exist (or have been separately docker save/load restored).
  assert.equal(await docker(['image','inspect','--format','{{.Id}}',fixture.imageDigest]),fixture.imageDigest)
  const dependenciesDir = await files.verifyBundleFiles(binding.bundle,dependencies.lockOf(binding.bundle.id)!)
  for (const dir of [dependenciesDir,storage.openDir(competition.id),storage.inputDir(competition.id,fixture.submissionId),storage.secretDir(competition.id)]) readable(dir)
  const attemptId = randomUUID()
  const resultDir = storage.attemptDir(competition.id,fixture.submissionId,attemptId)
  const run = await competitionRunner().run({attemptId,competition,submissionId:fixture.submissionId,container:`colloq-restore-run-${attemptId}`,
    imageDigest:binding.revision.imageDigest,dependenciesDir,dataDir:storage.openDir(competition.id),inputDir:storage.inputDir(competition.id,fixture.submissionId),
    resultDir,limits:limitsFor(competition,'notebook'),signal:AbortSignal.timeout(120_000)})
  assert.equal(run.status,'ok',JSON.stringify(run))
  assert.ok(run.submission)
  const answer = fs.readFileSync(run.submission)
  const scoreInput = storage.attemptDir(competition.id,fixture.submissionId,attemptId,'score')
  fs.writeFileSync(path.join(scoreInput,'submission.csv'),answer,{mode:0o444})
  readable(scoreInput)
  const score = await competitionRunner().score({attemptId,competition,submissionId:fixture.submissionId,container:`colloq-restore-score-${attemptId}`,
    imageDigest:binding.revision.imageDigest,secretDir:storage.secretDir(competition.id),submissionDir:scoreInput,
    outDir:storage.attemptDir(competition.id,fixture.submissionId,attemptId,'score-out'),limits:limitsFor(competition,'metric'),signal:AbortSignal.timeout(120_000)})
  assert.equal(score.status,'ok',JSON.stringify(score))
  assert.equal(score.public,0); assert.equal(score.private,0)
  competitions.updateSubmission(fixture.submissionId,{state:'scored',stage:'score',publicScore:score.public,privateScore:score.private})
  competitions.leaveQueue(fixture.submissionId)
  fs.writeFileSync(path.join(root,'run-summary.json'),JSON.stringify({attemptId,imageDigest:binding.revision.imageDigest,bundleHash:binding.bundle.contentHash,
    answerHash:hash(answer),publicScore:score.public,privateScore:score.private,packages:binding.bundle.packages.map(pkg=>({name:pkg.name,sha256:pkg.sha256}))}))
} finally { closeDatabase() }
