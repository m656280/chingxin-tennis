'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync(require.resolve('./index.js'), 'utf8');
const frontend = fs.readFileSync(require.resolve('../index.html'), 'utf8');
const rules = fs.readFileSync(require.resolve('../firestore.rules'), 'utf8');

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert(start >= 0, `${name} not found`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`${name} incomplete`);
}

const context = {crypto};
vm.createContext(context);
vm.runInContext([
  extractFunction('cleanString'),
  extractFunction('normaliseMemberName'),
  extractFunction('shouldDetectDuplicateMember'),
  extractFunction('duplicateMemberPairId'),
].join('\n'), context);

assert.strictEqual(context.normaliseMemberName(' 王　小 明 '), '王小明');
assert.strictEqual(context.normaliseMemberName('Ａlice Chen'), 'alicechen');

assert.strictEqual(context.shouldDetectDuplicateMember(
  null, {memberSource: 'line', realName: '王小明'}, false,
), true);
assert.strictEqual(context.shouldDetectDuplicateMember(
  null, {memberSource: 'manual', realName: '王小明'}, false,
), false);
assert.strictEqual(context.shouldDetectDuplicateMember(
  {realName: '王小明', lastLoginAt: 1},
  {memberSource: 'line', realName: '王小明', lastLoginAt: 2}, true,
), false);
assert.strictEqual(context.shouldDetectDuplicateMember(
  {realName: '王小明'}, {memberSource: 'line', realName: '王小華'}, true,
), true);
assert.strictEqual(context.shouldDetectDuplicateMember(
  {realName: '王 小明'}, {memberSource: 'line', realName: '王　小明'}, true,
), false);
assert.strictEqual(context.shouldDetectDuplicateMember(
  {realName: '舊姓名'}, {realName: '新姓名'}, true,
), true);

const pairId = context.duplicateMemberPairId('LINE_UID', 'MANUAL_UID');
assert.strictEqual(pairId.length, 64);
assert.strictEqual(
  context.duplicateMemberPairId('LINE_UID', 'MANUAL_UID'), pairId,
);
assert.notStrictEqual(
  context.duplicateMemberPairId('MANUAL_UID', 'LINE_UID'), pairId,
);

[
  'exports.detectDuplicateManualMember = onDocumentWritten',
  "where('memberSource', '==', 'manual')",
  "collection('duplicateMemberCandidates')",
  'shouldDetectDuplicateMember(before, after, beforeExists)',
  'bookingDb.runTransaction',
  "status: 'pending'",
  "matchReasons: ['exact_real_name']",
].forEach((text) => assert(source.includes(text), `backend wiring missing: ${text}`));

[
  'duplicateMemberCandidatesCache',
  'function loadDuplicateMemberCandidates',
  "if(role==='owner') loadDuplicateMemberCandidates()",
  '⚠️ 疑似重複會員（',
  'LINE 本人登入會員',
  '疑似對應手動會員',
  '待確認合併',
].forEach((text) => assert(frontend.includes(text), `frontend wiring missing: ${text}`));

assert(rules.includes('match /duplicateMemberCandidates/{candidateId}'));
assert(rules.includes('allow read: if isOwner();'));
assert(rules.includes('allow create, update, delete: if false;'));

console.log('PASS only member creation or normalised realName changes trigger detection');
console.log('PASS lastLoginAt-only updates and manual member writes are skipped');
console.log('PASS exact-name normalisation and deterministic pair IDs');
console.log('PASS Owner-only UI and Firestore Rules wiring');
