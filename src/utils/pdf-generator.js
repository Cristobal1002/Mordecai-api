import puppeteer from 'puppeteer';

/** Avoid networkidle0: letter HTML may reference external images/fonts and never go “idle”, causing 30s timeouts. */
const SET_CONTENT_WAIT = 'domcontentloaded';
const SET_CONTENT_TIMEOUT_MS = Number(process.env.PUPPETEER_SET_CONTENT_TIMEOUT_MS) || 60_000;

const defaultLaunchOptions = () => ({
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
  ],
});

/**
 * Render HTML to PDF buffer using Puppeteer.
 * @param {object} opts
 * @param {string} opts.html - full HTML document or body fragment
 * @param {string} [opts.title]
 */
export async function renderHtmlToPdfBuffer({ html, title = 'Document' }) {
  const raw = String(html || '').trim();
  if (!raw) throw new Error('html is required');

  const fullHtml =
    /<html[\s>]/i.test(raw) || /<!doctype/i.test(raw)
      ? raw
      : `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <style>
      @page { margin: 24px; }
      body { font-family: Arial, Helvetica, sans-serif; color: #111827; }
    </style>
  </head>
  <body>${raw}</body>
</html>`;

  const browser = await puppeteer.launch(defaultLaunchOptions());
  try {
    const page = await browser.newPage();
    await page.setContent(fullHtml, {
      waitUntil: SET_CONTENT_WAIT,
      timeout: SET_CONTENT_TIMEOUT_MS,
    });
    const pdfBuffer = await page.pdf({
      format: 'Letter',
      printBackground: true,
    });
    return Buffer.from(pdfBuffer);
  } finally {
    await browser.close();
  }
}

