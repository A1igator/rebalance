'use strict';

// Fixed negative fixtures only. This distinguishes an observed SDK rejection
// from the app's count-guard rejection; neither is a completed signature.
function assertExpectedRefusal({ fixtureCase, status, steps = [], events = [], requests = [], signatureCompleted }) {
  const expected = /^(router|batch)-(missing|extra)-call$/.exec(fixtureCase || '');
  if (!expected) return { expected: false, passed: false, boundary: null };
  const apdus = requests.filter(item => typeof item.apduHeader === 'string');
  const noReview = events.length > 0 && events.every(text => text.replace(/[\s|]/g, '') === 'Ethereumappisready');
  const noBasicResponse = !apdus.some(item => /^e004[0-9a-f]{2}00/i.test(item.apduHeader) && !item.blocked);
  const noCompletedSigningApdu = !apdus.some(item => /^e004[0-9a-f]{2}02/i.test(item.apduHeader) && !item.blocked && item.statusWord === '9000');
  let boundary = null;
  if (expected[2] === 'missing' && status === 'device-error' && steps.at(-1) === 'signer.eth.steps.buildContexts' &&
      apdus.some(item => /^e002/i.test(item.apduHeader) && item.statusWord === '9000') &&
      apdus.some(item => /^e020/i.test(item.apduHeader) && item.statusWord === '9000') &&
      !apdus.some(item => /^(e004|e026|e028)/i.test(item.apduHeader))) boundary = 'sdk-context-build';
  if (expected[2] === 'extra') {
    const fields = apdus.filter(item => /^e028/i.test(item.apduHeader));
    if (status === 'blind-signing-refused' && fields.length === 1 &&
        fields[0].apduHeader.toLowerCase() === 'e02801005e' && fields[0].statusWord === '6a80' &&
        apdus.some(item => /^e026/i.test(item.apduHeader) && item.statusWord === '9000')) boundary = 'device-count-guard';
  }
  return { expected: true, passed: Boolean(boundary && noReview && noBasicResponse && noCompletedSigningApdu && !signatureCompleted),
    boundary, noReview, noBasicResponse, noCompletedSigningApdu, signatureCompleted: Boolean(signatureCompleted),
    scope: 'Observed rejection of the fixed synthetic negative fixture only; no production or general ABI coverage claim' };
}
module.exports = { assertExpectedRefusal };
