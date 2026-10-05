const fs = require('fs');
const path = require('path');

const PROJECT_ID = 'pufforia-977d1';
const FIRESTORE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/site_config/main`;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function firestoreString(fields, key) {
  const field = fields && fields[key];
  if (!field) return '';
  if (typeof field.stringValue === 'string') return field.stringValue;
  if (typeof field.referenceValue === 'string') return field.referenceValue;
  return '';
}

function absoluteUrl(value, req) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw, `https://${req.headers.host}`).href;
  } catch {
    return '';
  }
}

async function loadSiteConfig() {
  const response = await fetch(FIRESTORE_URL, {
    headers: { Accept: 'application/json' },
    cache: 'no-store'
  });
  if (!response.ok) throw new Error(`Firestore HTTP ${response.status}`);
  return response.json();
}

module.exports = async function handler(req, res) {
  const indexPath = path.join(process.cwd(), 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');

  let config = {};
  try {
    const doc = await loadSiteConfig();
    config = doc.fields || {};
  } catch (error) {
    console.error('Social preview Firestore read failed:', error);
  }

  const title = firestoreString(config, 'socialTitle') || firestoreString(config, 'shopTitle') || '𝙈𝙮 𝙡𝙖𝙣𝙙 ♡';
  const description = firestoreString(config, 'socialDescription') || firestoreString(config, 'shopDesc') || 'ยินดีต้อนรับสู่เว็บไซต์ของร้านค่ะ ♡';
  const image = absoluteUrl(
    firestoreString(config, 'socialImage') || firestoreString(config, 'coverImg'),
    req
  );
  const pageUrl = `https://${req.headers.host || ''}/`;

  const replacements = {
    'og:title': title,
    'og:description': description,
    'og:image': image,
    'og:url': pageUrl,
    'twitter:title': title,
    'twitter:description': description,
    'twitter:image': image,
    'description': description
  };

  for (const [key, value] of Object.entries(replacements)) {
    const escaped = escapeHtml(value);
    if (key === 'description') {
      html = html.replace(/(<meta\s+name=["']description["'][^>]*content=["'])[^"']*(["'][^>]*>)/i, `$1${escaped}$2`);
    } else {
      const attr = key.startsWith('twitter:') ? 'name' : 'property';
      const pattern = new RegExp(`(<meta\\s+${attr}=["']${key.replace(':', '\\:')}["'][^>]*content=["'])[^"']*(["'][^>]*>)`, 'i');
      html = html.replace(pattern, `$1${escaped}$2`);
    }
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.status(200).send(html);
};
