const crypto = require('crypto');

function slugify(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

function inviteCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function cleanText(value, max = 80) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function asNumber(value) {
  if (value === '' || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatScore(value) {
  return Number(value || 0).toFixed(3);
}

function shuffled(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

module.exports = {
  slugify,
  inviteCode,
  normalizeEmail,
  cleanText,
  asNumber,
  formatScore,
  shuffled
};
