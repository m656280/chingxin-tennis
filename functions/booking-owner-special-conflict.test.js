'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync(require.resolve('./index.js'), 'utf8');
const frontend = fs.readFileSync(require.resolve('../index.html'), 'utf8');

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

const context = {Set};
vm.createContext(context);
vm.runInContext([
  extractFunction('normaliseBookingMode'),
  extractFunction('isActiveBooking'),
  extractFunction('timeToMinutes'),
  extractFunction('bookingStartMs'),
  extractFunction('bookingEndMs'),
  extractFunction('bookingIntervalsOverlap'),
  extractFunction('bookingParticipantUids'),
  extractFunction('findCourtConflict'),
  extractFunction('findParticipantConflictUid'),
  extractFunction('shouldBypassParticipantConflict'),
].join('\n'), context);

const existing = [{
  id: 'existing',
  date: '2026-09-03',
  startTime: '13:00',
  endTime: '16:00',
  court: 'hard_a',
  mode: 'general',
  status: 'active',
  players: ['member-a'],
}];
const candidate = {
  id: 'candidate',
  date: '2026-09-03',
  startTime: '14:00',
  endTime: '15:00',
  court: 'hard_b',
  status: 'active',
  players: ['member-a'],
};

assert.strictEqual(context.findParticipantConflictUid(existing, candidate, ''), 'member-a');
assert.strictEqual(context.shouldBypassParticipantConflict('owner', 'groupClass'), true);
assert.strictEqual(context.shouldBypassParticipantConflict('owner', 'group_class'), true);
assert.strictEqual(context.shouldBypassParticipantConflict('owner', 'event_lock'), true);
assert.strictEqual(context.shouldBypassParticipantConflict('owner', 'general'), false);
assert.strictEqual(context.shouldBypassParticipantConflict('owner', 'teaching'), false);
['admin', 'coach', 'member'].forEach((role) => {
  assert.strictEqual(context.shouldBypassParticipantConflict(role, 'groupClass'), false);
  assert.strictEqual(context.shouldBypassParticipantConflict(role, 'event_lock'), false);
});

const sameCourtCandidate = Object.assign({}, candidate, {court: 'hard_a'});
assert.strictEqual(context.findCourtConflict(existing, sameCourtCandidate, '').id, 'existing');

assert(frontend.includes(
  '_shouldBypassParticipantConflict(normMode)',
), 'edit path must apply owner special-mode bypass');
assert(frontend.includes(
  '_shouldBypassParticipantConflict(mode)',
), 'create path must apply owner special-mode bypass');
assert.strictEqual(
  (source.match(/!shouldBypassParticipantConflict\(/g) || []).length,
  2,
  'create and update callable paths must apply owner special-mode bypass',
);

console.log('PASS owner groupClass/event_lock bypass participant time conflicts');
console.log('PASS owner general/teaching still enforce participant time conflicts');
console.log('PASS admin/coach/member permissions remain unchanged');
console.log('PASS same-court conflicts remain enforced');
console.log('PASS create and edit frontend paths apply the same bypass');
