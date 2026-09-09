import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readCouncilSettings} from '../shared/notebook.js'
import {mayRunCouncil} from '../shared/rules.js'

test('request mode survives settings parsing and never grants direct student execution',()=>{
 assert.equal(readCouncilSettings({studentRun:'request'}).studentRun,'request')
 assert.equal(mayRunCouncil('participant','request',false),false)
 assert.equal(mayRunCouncil('host','request',false),true)
 assert.equal(mayRunCouncil('participant',true,false),true)
 assert.equal(mayRunCouncil('participant',true,true),false)
 assert.equal(readCouncilSettings({studentRun:'unrecognised'}).studentRun,false)
 assert.equal(readCouncilSettings({studentRun:true}).studentRun,true)
 assert.equal(readCouncilSettings({}).studentRun,false)
})
