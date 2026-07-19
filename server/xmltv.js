const { XMLParser } = require('fast-xml-parser');

// XMLTV timestamps look like "20260719063000 +0000" or sometimes with no offset.
function parseXmltvTime(str) {
  if (!str) return null;
  const m = String(str).trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, offset] = m;
  let iso = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  if (offset) {
    iso += `${offset.slice(0, 3)}:${offset.slice(3)}`;
  } else {
    iso += 'Z';
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
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

module.exports = { parseXmltv, parseXmltvTime };
