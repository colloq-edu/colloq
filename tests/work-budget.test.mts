import './_env.mts'
import assert from 'node:assert/strict'
import {test} from 'node:test'

test('background reservations share one admission budget and release once',async()=>{
 const {reserveWork,workBudgetSnapshot}=await import('../server/src/ops/work-budget.js');
 const preparation=reserveWork({id:'prep',kind:'preparation',memoryMb:1664,diskBytes:1024},{availableMemoryMb:4096,availableDiskBytes:4096});assert(preparation);
 const notebook=reserveWork({id:'run',kind:'competition',memoryMb:3072,diskBytes:256},{availableMemoryMb:4096,availableDiskBytes:4096});assert.equal(notebook,null);
 const disk=reserveWork({id:'disk',kind:'competition',memoryMb:0,diskBytes:3500},{availableDiskBytes:4096});assert.equal(disk,null);
 assert.equal(workBudgetSnapshot().jobs,1);preparation();preparation();assert.deepEqual(workBudgetSnapshot(),{memoryMb:0,diskBytes:0,jobs:0,byKind:{competition:0,preparation:0,kernel:0}});
});
test('reservation rejects invalid resource amounts and duplicate owners',async()=>{
 const {reserveWork}=await import('../server/src/ops/work-budget.js');
 assert.throws(()=>reserveWork({id:'bad',kind:'competition',memoryMb:-1,diskBytes:0},{}));
 const release=reserveWork({id:'same',kind:'competition',memoryMb:0,diskBytes:0},{});assert(release);
 assert.equal(reserveWork({id:'same',kind:'competition',memoryMb:0,diskBytes:0},{}),null);release();
});
