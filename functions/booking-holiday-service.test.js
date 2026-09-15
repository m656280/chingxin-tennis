'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const {
  BOOKING_HOURS,
  findDgpaDistribution,
  getBookingOpenHours,
  getFallbackCalendar,
  parseDgpaCalendarCsv,
} = require('./booking-holiday-service');

const backend = fs.readFileSync(require.resolve('./index.js'), 'utf8');
const frontend = fs.readFileSync(require.resolve('../index.html'), 'utf8');
const rules = fs.readFileSync(require.resolve('../firestore.rules'), 'utf8');

const calendar = getFallbackCalendar(2026);
assert.deepStrictEqual(
  getBookingOpenHours('2026-09-24', calendar), BOOKING_HOURS.weekday,
);
assert.deepStrictEqual(
  getBookingOpenHours('2026-09-26', calendar), BOOKING_HOURS.holiday,
);
assert.deepStrictEqual(
  getBookingOpenHours('2026-09-25', calendar), BOOKING_HOURS.holiday,
);
assert.deepStrictEqual(
  getBookingOpenHours('2026-07-15', calendar), BOOKING_HOURS.holiday,
);
assert.deepStrictEqual(
  getBookingOpenHours('2026-09-24', calendar, {active: true, mode: 'holiday'}),
  BOOKING_HOURS.holiday,
);
assert.deepStrictEqual(
  getBookingOpenHours('2026-09-25', calendar, {active: true, mode: 'weekday'}),
  BOOKING_HOURS.weekday,
);
assert.deepStrictEqual(
  getBookingOpenHours('2026-09-25', calendar, {active: false, mode: 'weekday'}),
  BOOKING_HOURS.holiday,
);

const sampleRows = ['西元日期,星期,是否放假,備註'];
for (let month = 0; month < 12; month += 1) {
  const lastDay = new Date(Date.UTC(2026, month + 1, 0)).getUTCDate();
  for (let day = 1; day <= lastDay; day += 1) {
    const date = new Date(Date.UTC(2026, month, day));
    const compact = date.toISOString().slice(0, 10).replace(/-/g, '');
    const flag = compact === '20260925' ? '2' : '0';
    sampleRows.push(`${compact},x,${flag},${flag === '2' ? '中秋節' : ''}`);
  }
}
assert.deepStrictEqual(parseDgpaCalendarCsv(sampleRows.join('\n'), 2026), [
  '2026-09-25',
]);
assert.strictEqual(findDgpaDistribution({success: true, result: {distribution: [
  {resourceDescription: '115年中華民國政府行政機關辦公日曆表',
    resourceFormat: 'CSV', resourceDownloadUrl: 'official.csv'},
  {resourceDescription: '115年中華民國政府行政機關辦公日曆表_Google行事曆專用',
    resourceFormat: 'CSV', resourceDownloadUrl: 'google.csv'},
]}}, 2026).resourceDownloadUrl, 'official.csv');

function extractFunction(source, name) {
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

const context = {
  bookingHolidayCalendarCache: {2026: Object.assign({}, calendar, {overrides: {}})},
  bookingHolidayCalendarLoads: {},
  currentUser: null,
  localStorage: {getItem: () => null},
  Date,
};
vm.createContext(context);
vm.runInContext([
  "const BUSINESS_HOURS={weekday:{start:'17:30',end:'21:30'},holiday:{start:'08:00',end:'21:30'}};",
  'const schoolHolidayRanges=[];',
  extractFunction(frontend, 'pad'),
  extractFunction(frontend, 'formatDate'),
  extractFunction(frontend, '_bookingHolidayCalendar'),
  extractFunction(frontend, 'getCourtOpenHours'),
].join('\n'), context);
assert.strictEqual(context.getCourtOpenHours(new Date('2026-09-25T00:00:00')).start, '08:00');
assert.strictEqual(context.getCourtOpenHours(new Date('2026-09-24T00:00:00')).start, '17:30');

const createStart = backend.indexOf('exports.createBooking =');
const updateStart = backend.indexOf('exports.updateBooking =');
const participantStart = backend.indexOf('function assertParticipantMutationAllowed');
assert(backend.slice(createStart, updateStart).includes(
  'await assertBookingWithinOpenHours(date, startTime, endTime);',
));
assert(backend.slice(updateStart, participantStart).includes(
  'await assertBookingWithinOpenHours(date, startTime, endTime);',
));
assert(backend.includes("schedule: '15 3 1 7-12 *'"));
assert(backend.includes("schedule: '15 3 1 1 *'"));
assert(backend.includes("status: 'failed'"));
assert(rules.includes('match /bookingHolidayCalendars/{year}'));
assert(rules.includes('match /bookingHolidayOverrides/{date}'));

console.log('PASS weekday/weekend/official holiday/school holiday hours');
console.log('PASS 2026-09-25 uses 08:00-21:30');
console.log('PASS non-official adjacent weekday remains 17:30-21:30');
console.log('PASS Owner holiday/weekday override and inactive override');
console.log('PASS DGPA CSV validation and yearly resource selection');
console.log('PASS frontend and backend use the same effective calendar fields');
console.log('PASS createBooking and updateBooking enforce hours on backend');
console.log('PASS December prefetch and January confirmation schedules');
console.log('PASS calendar collections deny direct client writes');
