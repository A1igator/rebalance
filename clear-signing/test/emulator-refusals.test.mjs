import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {assertExpectedRefusal} from '../emulator/assert-refusal.cjs';
const captures=JSON.parse(readFileSync(new URL('../emulator/evidence/matching-count-refusals.json',import.meta.url),'utf8')).cases;
const check=capture=>assertExpectedRefusal(capture);

test('real fixed negative captures distinguish SDK bounds rejection from device count enforcement',()=>{
  assert.equal(captures.length,4);
  for(const c of captures){
    const result=check(c);
    assert.equal(result.passed,true,JSON.stringify({fixture:c.fixtureCase,result}));
    assert.equal(result.boundary,c.fixtureCase.includes('missing')?'sdk-context-build':'device-count-guard');
    assert.equal(result.noReview,true);
    assert.equal(result.noCompletedSigningApdu,true);
  }
});
test('a signature or successful generic completion cannot be hidden by a later refusal status',()=>{
  for(const c of captures){
    assert.equal(check({...c,signatureCompleted:true}).passed,false);
    assert.equal(check({...c,requests:[...c.requests,{apduHeader:'e004000200',statusWord:'9000'}]}).passed,false);
    assert.equal(check({...c,requests:[...c.requests,{apduHeader:'e00400007e',statusWord:'6a80'}]}).passed,false);
    assert.equal(check({...c,events:[...c.events,'Review transaction to | Execute batch']}).passed,false);
  }
});
test('unrelated errors and later field failures cannot masquerade as the count guard',()=>{
  for(const c of captures){
    assert.equal(check({...c,status:'timeout'}).passed,false);
    assert.equal(check({...c,events:[]}).passed,false);
    assert.equal(check({...c,fixtureCase:'batch'}).expected,false);
  }
  const extra=captures.find(c=>c.fixtureCase==='router-extra-call');
  assert.equal(check({...extra,requests:extra.requests.map(r=>r.apduHeader==='e02801005e'?{...r,statusWord:'9000'}:r)}).passed,false);
  assert.equal(check({...extra,requests:[...extra.requests,{apduHeader:'e028010062',statusWord:'6a80'}]}).passed,false);
  const missing=captures.find(c=>c.fixtureCase==='batch-missing-call');
  assert.equal(check({...missing,steps:['signer.eth.steps.getAddress']}).passed,false);
  assert.equal(check({...missing,requests:[...missing.requests,{apduHeader:'e0040001ff',statusWord:'9000'}]}).passed,false);
});
