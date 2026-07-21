const { XMLParser } = require('fast-xml-parser');

// Converts a "civil"/wall-clock date+time as it would read on a clock in the
// given IANA timezone into the correct UTC epoch ms. Standard double-format
// trick - no dependency needed, and it correctly accounts for DST.
function zonedTimeToUtc(y, mo, d, h, mi, s, timeZone) {
  const guessUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = fmt.formatToParts(new Date(guessUtc)).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  // midnight is sometimes rendered as "24" by Intl - normalize to 0
  const hour = parts.hour === '24' ? 0 : Number(parts.hour);
  const renderedAsUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    hour, Number(parts.minute), Number(parts.second)
  );
  const driftFromIntendedZone = renderedAsUtc - guessUtc;
  return guessUtc - driftFromIntendedZone;
}

// XMLTV timestamps look like "20260719063000 +0000" (offset present) or, for
// some providers, just "20260719063000" with no offset at all. When there's
// no offset, those digits are wall-clock time in *some* timezone - almost
// always the machine/provider's local time, not UTC - so we interpret it
// using TZ (falls back to UTC if TZ isn't set, matching prior behavior).
function parseXmltvTime(str, fallbackTimeZone) {
  if (!str) return null;
  const m = String(str).trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, offset] = m;

  if (offset) {
    const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${offset.slice(0, 3)}:${offset.slice(3)}`;
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? null : ms;
  }

  const tz = fallbackTimeZone || process.env.TZ || 'UTC';
  try {
    return zonedTimeToUtc(Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s), tz);
  } catch {
    // unknown/invalid TZ string - fall back to the old UTC-literal behavior
    const ms = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
    return Number.isNaN(ms) ? null : ms;
  }
}

function asArray(x) {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

function textOf(node) {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (typeof node === 'object' && '#text' in node) return String(node['#text']);
  return '';
}

function parseXmltv(xmlString) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    parseTagValue: true,
    trimValues: true,
  });
  const doc = parser.parse(xmlString);
  const tv = doc.tv || {};

  const channels = asArray(tv.channel).map((c) => ({
    id: c['@_id'],
    displayName: textOf(asArray(c['display-name'])[0]),
  }));

  const programmes = asArray(tv.programme)
    .map((p) => {
      const start = parseXmltvTime(p['@_start']);
      const stop = parseXmltvTime(p['@_stop']);
      if (start === null || stop === null) return null;
      return {
        channel: p['@_channel'],
        start,
        stop,
        title: textOf(p.title) || '(untitled)',
        description: textOf(p.desc) || '',
      };
    })
    .filter(Boolean);

  return { channels, programmes };
}

module.exports = { parseXmltv, parseXmltvTime, zonedTimeToUtc };
