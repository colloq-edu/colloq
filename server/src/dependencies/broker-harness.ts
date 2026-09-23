import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { dependencyRoot } from './files.js'
import { PREPARATION_PYTHON } from './preparation-python.js'

const INVENTORY=String.raw`import json, platform, sysconfig, importlib.metadata as metadata
from pathlib import Path
report = {'python':platform.python_version(), 'abi':sysconfig.get_config_var('SOABI'),
          'platform':platform.system().lower() + '/' + platform.machine().lower(),
          'packages':[{'name':d.metadata['Name'],'version':d.version} for d in metadata.distributions()]}
Path('/out/inventory.json').write_text(json.dumps(report, separators=(',', ':')), encoding='utf-8')
`

/** Fixed broker mount has no competition or submission data. */
export function dependencyBrokerHarnessDir():string {
  const dir=path.join(dependencyRoot,'harness')
  fs.mkdirSync(dir,{recursive:true,mode:0o755})
  for(const [name,body] of [['broker_prepare.py',PREPARATION_PYTHON],['broker_inventory.py',INVENTORY]]) {
    const file=path.join(dir,name)
    const expected=createHash('sha256').update(body).digest('hex')
    if(fs.existsSync(file)&&createHash('sha256').update(fs.readFileSync(file)).digest('hex')===expected)continue
    const temp=path.join(dir,`.${name}.${process.pid}.tmp`)
    fs.writeFileSync(temp,body,{mode:0o644})
    fs.renameSync(temp,file)
  }
  return dir
}
