/**
 * Replace <!-- {{SIGNATURE_BLOCK}} --> in letter HTML with inline signature image + lines.
 * Puppeteer lays out the PDF; avoids fixed pdf-lib coordinates when the anchor is present.
 */

const SIGNATURE_BLOCK_RE = /<!--\s*\{\{\s*SIGNATURE_BLOCK\s*\}\}\s*-->/i;

/** Editor (TipTap) may send this if a non-browser client saved HTML — normalize before PDF. */
const SIGNATURE_EDITOR_DIV_RE = /<div\b[^>]*data-type="mordecai-signature"[^>]*>[\s\S]*?<\/div>/gi;

export function normalizeSignatureMarkersToComment(html) {
  return String(html || '').replace(SIGNATURE_EDITOR_DIV_RE, '<!-- {{SIGNATURE_BLOCK}} -->');
}

const esc = (s) =>
  String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * @param {string} html
 * @param {object} opts
 * @param {string|null} [opts.signaturePngBase64] - raw base64 without data: prefix
 * @param {string|undefined} [opts.signatoryName]
 * @param {string|undefined} [opts.signatoryTitle]
 * @param {number} [opts.maxImageWidthPx]
 * @returns {{ html: string, usedAnchor: boolean }}
 */
export function injectSignatureBlockIntoHtml(html, opts = {}) {
  const raw = String(html || '');
  if (!SIGNATURE_BLOCK_RE.test(raw)) {
    return { html: raw, usedAnchor: false };
  }

  const {
    signaturePngBase64 = null,
    signatoryName,
    signatoryTitle,
    maxImageWidthPx = 200,
  } = opts;

  const img =
    signaturePngBase64 && String(signaturePngBase64).trim()
      ? `<img src="data:image/png;base64,${String(signaturePngBase64).trim()}" alt="" style="max-width:${maxImageWidthPx}px;height:auto;display:block;" />`
      : '';

  const lines = [signatoryName, signatoryTitle]
    .filter((v) => typeof v === 'string' && v.trim())
    .map((v) => `<div style="font-size:11pt;margin-top:4px;">${esc(v.trim())}</div>`)
    .join('');

  const block = `<div class="letter-signature-block" style="margin-top:0.35in;">${img}${lines}</div>`;
  return { html: raw.replace(SIGNATURE_BLOCK_RE, block), usedAnchor: true };
}

/**
 * If the letter HTML contains <!-- {{SIGNATURE_BLOCK}} -->, replace it with inline layout
 * (optional PNG + signatory lines). Otherwise leaves HTML unchanged.
 * When `usedAnchor` is true, skip pdf-lib stamping after Puppeteer.
 *
 * @param {string} html
 * @param {object|null} branding - TenantBranding row or similar
 * @param {Buffer|null} signatureBuf
 * @returns {{ htmlForPdf: string, usedAnchor: boolean }}
 */
export function prepareLetterHtmlWithOptionalSignature(html, branding, signatureBuf) {
  const raw = String(html || '');
  if (!SIGNATURE_BLOCK_RE.test(raw)) {
    return { htmlForPdf: raw, usedAnchor: false };
  }
  const b64 =
    signatureBuf && Buffer.isBuffer(signatureBuf) && signatureBuf.length
      ? signatureBuf.toString('base64')
      : null;
  const { html: next, usedAnchor } = injectSignatureBlockIntoHtml(raw, {
    signaturePngBase64: b64,
    signatoryName: branding?.signatoryName ?? undefined,
    signatoryTitle: branding?.signatoryTitle ?? undefined,
  });
  return { htmlForPdf: next, usedAnchor };
}
