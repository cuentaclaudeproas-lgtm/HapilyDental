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
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return download(res.headers.location, filepath).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(filepath);
        return reject(new Error('HTTP ' + res.statusCode));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      fs.unlink(filepath, () => reject(err));
    });
  });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'es-ES',
  });
  const page = await ctx.newPage();

  const url = `https://www.instagram.com/${HANDLE}/`;
  console.log('Navegando a', url);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    console.log('GOTO_FAIL', e.message);
  }

  await page.waitForTimeout(3500);

  // Try to extract from meta tags first (most reliable)
  const metaData = await page.evaluate(() => {
    const m = (n) => document.querySelector(`meta[property="${n}"]`)?.content
      || document.querySelector(`meta[name="${n}"]`)?.content || '';
    return {
      ogTitle: m('og:title'),
      ogDescription: m('og:description'),
      ogImage: m('og:image'),
      description: m('description'),
      title: document.title,
    };
  });

  // Try to extract from window._sharedData / json-ld
  const jsonLd = await page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
    return scripts.map(s => s.textContent).filter(Boolean);
  });

  // Image URLs
  const imageUrls = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img'));
    return imgs
      .map(i => ({ src: i.src, alt: i.alt, w: i.naturalWidth, h: i.naturalHeight }))
      .filter(i => i.src && i.src.startsWith('http'));
  });

  // DOM-level profile info
  const domData = await page.evaluate(() => {
    const headerText = document.querySelector('header')?.innerText || '';
    const h1 = document.querySelector('h1')?.innerText || '';
    const h2 = document.querySelector('h2')?.innerText || '';
    return { headerText, h1, h2, bodyTextSample: document.body.innerText.slice(0, 2000) };
  });

  console.log('=== META ===');
  console.log(JSON.stringify(metaData, null, 2));
  console.log('=== JSON-LD ===');
  console.log(jsonLd.join('\n---\n').slice(0, 2000));
  console.log('=== DOM ===');
  console.log(JSON.stringify(domData, null, 2));
  console.log('=== IMAGES (' + imageUrls.length + ') ===');
  imageUrls.slice(0, 30).forEach((i, n) => console.log(n, i.w + 'x' + i.h, i.src.slice(0, 120)));

  // Save raw data
  fs.writeFileSync(path.join(__dirname, 'scrape-raw.json'), JSON.stringify({
    handle: HANDLE,
    metaData,
    jsonLd,
    domData,
    imageUrls,
  }, null, 2));

  // Try to download profile image
  if (metaData.ogImage) {
    try {
      await download(metaData.ogImage, path.join(OUT_DIR, 'profile.jpg'));
      console.log('Profile image saved');
    } catch (e) {
      console.log('Profile download failed:', e.message);
    }
  }

  // Filter post images: skip avatars/icons, prioritize bigger images
  const postImages = imageUrls
    .filter(i => i.src.includes('cdninstagram.com') || i.src.includes('fbcdn.net'))
    .filter(i => i.w >= 200 && i.h >= 200)
    .filter(i => !i.alt || !i.alt.toLowerCase().includes('profile photo'));

  console.log('Post images candidates:', postImages.length);

  // Scroll to load more
  for (let s = 0; s < 4; s++) {
    await page.mouse.wheel(0, 1500);
    await page.waitForTimeout(1200);
  }

  const moreImages = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('img'))
      .map(i => ({ src: i.src, alt: i.alt, w: i.naturalWidth, h: i.naturalHeight }))
      .filter(i => i.src && i.src.startsWith('http'));
  });

  const all = [...new Map([...imageUrls, ...moreImages].map(i => [i.src, i])).values()];
  const finalPosts = all
    .filter(i => i.src.includes('cdninstagram.com') || i.src.includes('fbcdn.net'))
    .filter(i => i.w >= 200 && i.h >= 200)
    .filter(i => !i.src.includes('s150x150') && !i.src.includes('s320x320'))
    .slice(0, 12);

  console.log('Final post images to download:', finalPosts.length);

  for (let i = 0; i < finalPosts.length; i++) {
    const out = path.join(OUT_DIR, `post-${i + 1}.jpg`);
    try {
      await download(finalPosts[i].src, out);
      console.log('Saved post-' + (i + 1) + '.jpg');
    } catch (e) {
      console.log('Failed post-' + (i + 1), e.message);
    }
  }

  await browser.close();
  console.log('DONE');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
