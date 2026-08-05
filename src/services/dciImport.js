const cheerio = require('cheerio');
const { query, withTransaction } = require('../db');
const config = require('../config');
const { slugify } = require('../utils');

const {
  parseNumbers,
  extractStandardRowScores,
  parseDateFromText
} = require('./dciParsing');

function assertImportAllowed() {
  if (!config.dciImportEnabled || !config.dciPermissionConfirmed) {
    throw new Error(
      'DCI import is disabled. Set DCI_IMPORT_ENABLED=true and DCI_PERMISSION_CONFIRMED=true only after receiving permission to reuse DCI score reports.'
    );
  }
  if (!config.dciContactEmail) {
    throw new Error('DCI_CONTACT_EMAIL is required for an identifiable importer user agent.');
  }
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': `CorpsDraft/1.0 score-import (${config.dciContactEmail})`,
      accept: 'text/html,application/xhtml+xml'
    },
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`DCI returned HTTP ${response.status} for ${url}`);
  return response.text();
}

function parseRecapHtml(html, sourceUrl, yearHint = config.dciSourceYear) {
  const $ = cheerio.load(html);
  const headingCandidates = $('h1').map((_, el) => $(el).text().trim()).get().filter(Boolean);
  const eventName = headingCandidates.at(-1) || 'Imported DCI Event';
  const pageText = $('body').text().replace(/\s+/g, ' ');
  const eventDate = parseDateFromText(pageText, yearHint);

  const rows = [];
  $('table tr').each((_, tr) => {
    const cells = $(tr).find('th, td').map((__, cell) => $(cell).text().replace(/\s+/g, ' ').trim()).get();
    if (cells.length < 2) return;
    const corpsName = cells[0];
    if (!corpsName || /corps|place/i.test(corpsName)) return;
    const numbers = parseNumbers(cells.slice(1).join(' '));
    const scores = extractStandardRowScores(numbers);
    if (scores) rows.push({ corpsName, scores });
  });

  if (!rows.length) {
    throw new Error('No standard single-panel recap rows were recognized. Use manual entry for this recap or update the parser for the current DCI table structure.');
  }

  return {
    name: eventName,
    slug: slugify(`${eventDate}-${eventName}`),
    eventDate,
    location: null,
    sourceUrl,
    rows
  };
}

async function upsertImportedEvent(parsed) {
  return withTransaction(async (client) => {
    const eventResult = await client.query(`
      INSERT INTO events (name, slug, event_date, location, source_url, source_kind, finalized)
      VALUES ($1, $2, $3, $4, $5, 'DCI_AUTHORIZED_IMPORT', TRUE)
      ON CONFLICT (slug) DO UPDATE SET
        name = EXCLUDED.name,
        event_date = EXCLUDED.event_date,
        location = EXCLUDED.location,
        source_url = EXCLUDED.source_url,
        updated_at = NOW()
      RETURNING id
    `, [parsed.name, parsed.slug, parsed.eventDate, parsed.location, parsed.sourceUrl]);
    const eventId = eventResult.rows[0].id;

    let scoreCount = 0;
    for (const row of parsed.rows) {
      const corpsSlug = slugify(row.corpsName);
      const corpsResult = await client.query(`
        INSERT INTO corps (name, slug, active)
        VALUES ($1, $2, TRUE)
        ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
        RETURNING id
      `, [row.corpsName, corpsSlug]);
      const corpsId = corpsResult.rows[0].id;

      for (const [captionCode, scores] of Object.entries(row.scores)) {
        await client.query(`
          INSERT INTO scores (event_id, corps_id, caption_code, first_score, second_score)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (event_id, corps_id, caption_code) DO UPDATE SET
            first_score = EXCLUDED.first_score,
            second_score = EXCLUDED.second_score,
            updated_at = NOW()
        `, [eventId, corpsId, captionCode, scores.first, scores.second]);
        scoreCount += 1;
      }
    }

    return { eventId, scoreCount };
  });
}

async function importRecapUrl(url) {
  assertImportAllowed();
  if (!/^https:\/\/(www\.)?dci\.org\/scores\/recap\//i.test(url)) {
    throw new Error('Only official dci.org recap URLs are accepted by this importer.');
  }
  const html = await fetchHtml(url);
  const parsed = parseRecapHtml(html, url);
  const result = await upsertImportedEvent(parsed);
  await query(`INSERT INTO sync_runs (source, status, message) VALUES ('DCI', 'SUCCESS', $1)`, [
    `Imported ${parsed.name}: ${result.scoreCount} caption rows`
  ]);
  return { ...parsed, ...result };
}

async function discoverRecapUrls(year = config.dciSourceYear) {
  assertImportAllowed();
  const html = await fetchHtml('https://www.dci.org/scores/');
  const $ = cheerio.load(html);
  const urls = new Set();
  $(`a[href*="/scores/recap/${year}-"]`).each((_, link) => {
    const href = $(link).attr('href');
    if (!href) return;
    urls.add(new URL(href, 'https://www.dci.org').href);
  });
  return [...urls];
}

async function syncDiscoveredRecaps() {
  const urls = await discoverRecapUrls();
  const results = [];
  for (const url of urls.slice(0, 50)) {
    try {
      results.push({ url, ok: true, result: await importRecapUrl(url) });
    } catch (error) {
      results.push({ url, ok: false, error: error.message });
    }
  }
  return results;
}

module.exports = {
  parseNumbers,
  extractStandardRowScores,
  parseRecapHtml,
  importRecapUrl,
  discoverRecapUrls,
  syncDiscoveredRecaps,
  assertImportAllowed
};
