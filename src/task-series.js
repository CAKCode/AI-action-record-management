'use strict';

const CRON_PARTS = [
  ['minute', 0, 59],
  ['hour', 0, 23],
  ['dayOfMonth', 1, 31],
  ['month', 1, 12],
  ['dayOfWeek', 0, 6],
];

function seriesError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function parseCronField(value, minimum, maximum, name) {
  const text = String(value || '').trim();
  if (!text) throw seriesError(`Cron ${name} field cannot be empty`);
  const values = new Set();
  for (const rawPart of text.split(',')) {
    const part = rawPart.trim();
    if (!part) throw seriesError(`Cron ${name} field contains an empty item`);
    const [rangeText, stepText] = part.split('/');
    if (part.split('/').length > 2) throw seriesError(`Cron ${name} field has too many separators`);
    const step = stepText == null ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw seriesError(`Cron ${name} step must be a positive integer`);
    let start;
    let end;
    if (rangeText === '*') {
      start = minimum;
      end = maximum;
    } else if (/^\d+$/.test(rangeText)) {
      start = Number(rangeText);
      end = stepText == null ? start : maximum;
    } else if (/^\d+-\d+$/.test(rangeText)) {
      [start, end] = rangeText.split('-').map(Number);
    } else {
      throw seriesError(`Cron ${name} field contains invalid value`);
    }
    if (start < minimum || end > maximum || start > end) {
      throw seriesError(`Cron ${name} field is outside ${minimum}-${maximum}`);
    }
    for (let item = start; item <= end; item += step) values.add(item);
  }
  return [...values].sort((left, right) => left - right);
}

function parseCron(expression) {
  const fields = String(expression || '').trim().split(/\s+/);
  if (fields.length !== 5) throw seriesError('Cron must contain five fields: minute hour day month weekday');
  return Object.fromEntries(fields.map((value, index) => {
    const [name, minimum, maximum] = CRON_PARTS[index];
    return [name, parseCronField(value, minimum, maximum, name)];
  }));
}

function validateTimeZone(timeZone) {
  const value = String(timeZone || '').trim() || 'Asia/Shanghai';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
  } catch {
    throw seriesError(`Unknown timezone: ${value}`);
  }
  return value;
}

function localParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal')
    .map((part) => [part.type, Number(part.value)]));
  return values;
}

function timeZoneOffsetMs(date, timeZone) {
  const parts = localParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

function localDateToUtc(year, month, day, hour, minute, timeZone) {
  const localTimestamp = Date.UTC(year, month - 1, day, hour, minute, 0);
  let candidate = localTimestamp;
  for (let index = 0; index < 3; index += 1) {
    candidate = localTimestamp - timeZoneOffsetMs(new Date(candidate), timeZone);
  }
  return new Date(candidate);
}

function cronMatchesDay(cron, date) {
  const monthMatches = cron.month.includes(date.getUTCMonth() + 1);
  if (!monthMatches) return false;
  const dayMatches = cron.dayOfMonth.includes(date.getUTCDate());
  const weekdayMatches = cron.dayOfWeek.includes(date.getUTCDay());
  const dayWildcard = cron.dayOfMonth.length === 31;
  const weekdayWildcard = cron.dayOfWeek.length === 7;
  if (dayWildcard && weekdayWildcard) return true;
  if (dayWildcard) return weekdayMatches;
  if (weekdayWildcard) return dayMatches;
  return dayMatches || weekdayMatches;
}

function nextCronAt(expression, after = new Date(), timeZone = 'Asia/Shanghai') {
  const cron = parseCron(expression);
  const zone = validateTimeZone(timeZone);
  const start = new Date(after);
  if (Number.isNaN(start.getTime())) throw seriesError('Cron base time is invalid');
  const current = localParts(start, zone);
  const localStart = Date.UTC(current.year, current.month - 1, current.day);
  const maxDays = 366;
  for (let dayOffset = 0; dayOffset <= maxDays; dayOffset += 1) {
    const localDate = new Date(localStart + dayOffset * 86400000);
    if (!cronMatchesDay(cron, localDate)) continue;
    for (const hour of cron.hour) {
      for (const minute of cron.minute) {
        const candidate = localDateToUtc(
          localDate.getUTCFullYear(), localDate.getUTCMonth() + 1, localDate.getUTCDate(),
          hour, minute, zone,
        );
        if (candidate > start) return candidate.toISOString();
      }
    }
  }
  throw seriesError('Cron has no occurrence in the next 366 days');
}

function normalizeSeriesId(value) {
  const normalized = String(value || '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) {
    throw seriesError('Series id must match ^[a-z0-9][a-z0-9_-]{0,63}$');
  }
  return normalized;
}

module.exports = {
  nextCronAt,
  normalizeSeriesId,
  parseCron,
  validateTimeZone,
};
