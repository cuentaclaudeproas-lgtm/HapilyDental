const { chromium } = require('playwright');
const fs = require('fs');
const https = require('https');
const path = require('path');

const HANDLE = process.argv[2] || 'hapylimx';
const OUT_DIR = path.join(__dirname, 'assets', 'instagram');

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

function download(url, filepath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(filepath);
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return download(res.headers.location, filepath).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(filepath); } catch (_) {}
        return reject(new Error('HTTP ' + res.statusCode));
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
    }).on('error', (err) => {
      try { fs.unlinkSync(filepath); } catch (_) {}
      reject(err);
    });
  });
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled']
  });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
    isMobile: true,
    locale: 'es-ES',
  });
  const page = await ctx.newPage();

  // Capture all image responses (network level)
  const imageUrls = new Set();
  page.on('response', async (resp) => {
    const url = resp.url();
    const type = resp.headers()['content-type'] || '';
    if ((url.includes('cdninstagram.com') || url.includes('fbcdn.net')) &&
        (type.startsWith('image/') || url.match(/\.(jpg|jpeg|png|webp)/i))) {
      imageUrls.add(url);
    }
  });

  const url = `https://www.instagram.com/${HANDLE}/`;
  console.log('Navegando (mobile UA) a', url);

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
  } catch (e) {
    console.log('GOTO timeout, continuing:', e.message);
  }

  await page.waitForTimeout(5000);

  // Scroll multiple times to trigger image loading
  for (let s = 0; s < 6; s++) {
    await page.evaluate(() => window.scrollBy(0, 800));
    await page.waitForTimeout(1500);
  }

  // Get images from DOM as well
  const domImgs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('img')).map(i => ({
      src: i.src, alt: i.alt, w: i.naturalWidth, h: i.naturalHeight
    }));
  });
  domImgs.forEach(i => { if (i.src) imageUrls.add(i.src); });

  console.log('Total network/dom image URLs captured:', imageUrls.size);

  // Filter to actual post images (not 100x100 avatar thumbs)
  const allUrls = Array.from(imageUrls);
  const candidates = allUrls.filter(u =>
    (u.includes('cdninstagram.com') || u.includes('fbcdn.net')) &&
    !u.includes('s100x100') &&
    !u.includes('s150x150') &&
    !u.includes('profile_pic')
  );

  console.log('Candidate post images:', candidates.length);
  candidates.slice(0, 20).forEach((u, n) => console.log(n, u.slice(0, 130)));

  // Save candidates
  fs.writeFileSync(path.join(__dirname, 'image-candidates.json'),
    JSON.stringify({ all: allUrls, candidates }, null, 2));

  // Download up to 12 unique-ish post images
  const seen = new Set();
  let downloaded = 0;
  for (const u of candidates) {
    // dedupe by the image id portion
    const idMatch = u.match(/\/([0-9]{10,})_/);
    const key = idMatch ? idMatch[1] : u.slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    if (downloaded >= 12) break;
    const out = path.join(OUT_DIR, `post-${downloaded + 1}.jpg`);
    try {
      await download(u, out);
      console.log('Saved post-' + (downloaded + 1) + '.jpg');
      downloaded++;
    } catch (e) {
      console.log('Skip:', e.message);
    }
  }

  console.log('Total downloaded:', downloaded);
  await browser.close();
  console.log('DONE');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
