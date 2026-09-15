'use strict';

const BOOKING_HOURS = Object.freeze({
  weekday: Object.freeze({start: '17:30', end: '21:30'}),
  holiday: Object.freeze({start: '08:00', end: '21:30'}),
});

const DGPA_DATASET_ID = 14718;
const DGPA_DATASET_URL =
  `https://data.gov.tw/api/v2/rest/dataset/${DGPA_DATASET_ID}`;

// Official DGPA weekday holidays bundled only as a first-run/cross-year fallback.
// Firestore bookingHolidayCalendars remains the live, annually synced source.
const FALLBACK_OFFICIAL_HOLIDAYS = Object.freeze({
  2026: Object.freeze([
    '2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18',
    '2026-02-19', '2026-02-20', '2026-02-27', '2026-04-03',
    '2026-04-06', '2026-05-01', '2026-06-19', '2026-09-25',
    '2026-09-28', '2026-10-09', '2026-10-26', '2026-12-25',
  ]),
  2027: Object.freeze([
    '2027-01-01', '2027-02-04', '2027-02-05', '2027-02-08',
    '2027-02-09', '2027-02-10', '2027-03-01', '2027-04-05',
    '2027-04-06', '2027-04-30', '2027-06-09', '2027-09-15',
    '2027-09-28', '2027-10-11', '2027-10-25', '2027-12-24',
    '2027-12-31',
  ]),
});

const SCHOOL_HOLIDAY_RANGES = Object.freeze({
  2026: Object.freeze([
    Object.freeze({start: '2026-01-21', end: '2026-02-10', type: 'winter'}),
    Object.freeze({start: '2026-07-01', end: '2026-08-31', type: 'summer'}),
  ]),
});

function dateParts(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 ||
      parsed.getUTCDate() !== day) return null;
  return {year, month, day, dayOfWeek: parsed.getUTCDay()};
}

function getFallbackCalendar(year) {
  return {
    year,
    timezone: 'Asia/Taipei',
    officialHolidayDates: [...(FALLBACK_OFFICIAL_HOLIDAYS[year] || [])],
    schoolHolidayRanges: [...(SCHOOL_HOLIDAY_RANGES[year] || [])],
    source: 'DGPA bundled fallback',
    sourceDatasetId: String(DGPA_DATASET_ID),
    isFallback: true,
  };
}

function getBookingOpenHours(date, calendar, override) {
  const parts = dateParts(date);
  if (!parts) throw new Error('Invalid booking date');
  if (parts.dayOfWeek === 0 || parts.dayOfWeek === 6) {
    return BOOKING_HOURS.holiday;
  }
  if (override && override.active !== false) {
    if (override.mode === 'weekday') return BOOKING_HOURS.weekday;
    if (override.mode === 'holiday') return BOOKING_HOURS.holiday;
  }
  const officialDates = calendar && Array.isArray(calendar.officialHolidayDates) ?
    calendar.officialHolidayDates : [];
  if (officialDates.includes(date)) return BOOKING_HOURS.holiday;
  const ranges = calendar && Array.isArray(calendar.schoolHolidayRanges) ?
    calendar.schoolHolidayRanges : [];
  if (ranges.some((range) => date >= range.start && date <= range.end)) {
    return BOOKING_HOURS.holiday;
  }
  return BOOKING_HOURS.weekday;
}

function parseCsvRows(csvText) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const text = String(csvText || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows;
}

function parseDgpaCalendarCsv(csvText, year) {
  const rows = parseCsvRows(csvText);
  const expectedRows = new Date(Date.UTC(year, 1, 29)).getUTCDate() === 29 ?
    366 : 365;
  if (rows.length < expectedRows) throw new Error('DGPA calendar rows incomplete');
  const dates = new Set();
  const holidays = [];
  rows.slice(1).forEach((row) => {
    const compactDate = String(row[0] || '').trim();
    const match = /^(\d{4})(\d{2})(\d{2})$/.exec(compactDate);
    if (!match || Number(match[1]) !== year) return;
    const date = `${match[1]}-${match[2]}-${match[3]}`;
    if (!dateParts(date)) throw new Error(`Invalid DGPA date: ${compactDate}`);
    const flag = String(row[2] || '').trim();
    if (flag !== '0' && flag !== '2') {
      throw new Error(`Invalid DGPA holiday flag: ${flag}`);
    }
    dates.add(date);
    if (flag === '2') holidays.push(date);
  });
  if (dates.size !== expectedRows) throw new Error('DGPA calendar year incomplete');
  return [...new Set(holidays)].sort();
}

function findDgpaDistribution(metadata, year) {
  const rocYear = year - 1911;
  const distributions = metadata && metadata.success && metadata.result &&
    Array.isArray(metadata.result.distribution) ? metadata.result.distribution : [];
  const matches = distributions.filter((item) => {
    const description = String(item.resourceDescription || '');
    return description.startsWith(`${rocYear}年`) &&
      !description.includes('Google') && item.resourceFormat === 'CSV' &&
      item.resourceDownloadUrl;
  });
  if (!matches.length) throw new Error(`DGPA calendar resource not found: ${year}`);
  return matches[matches.length - 1];
}

module.exports = {
  BOOKING_HOURS,
  DGPA_DATASET_ID,
  DGPA_DATASET_URL,
  SCHOOL_HOLIDAY_RANGES,
  dateParts,
  findDgpaDistribution,
  getBookingOpenHours,
  getFallbackCalendar,
  parseDgpaCalendarCsv,
};
