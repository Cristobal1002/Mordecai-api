import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

/**
 * Stamp a signature PNG onto a PDF.
 * MVP: fixed placement on first page (bottom-right). Caller should ensure PDF has space.
 *
 * @param {object} opts
 * @param {Buffer} opts.pdfBuffer
 * @param {Buffer} opts.signaturePngBuffer - transparent PNG recommended
 * @param {string} [opts.signatoryName]
 * @param {string} [opts.signatoryTitle]
 */
export async function stampSignatureOnPdf({
  pdfBuffer,
  signaturePngBuffer,
  signatoryName,
  signatoryTitle,
}) {
  if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer)) throw new Error('pdfBuffer is required');
  if (!signaturePngBuffer || !Buffer.isBuffer(signaturePngBuffer)) throw new Error('signaturePngBuffer is required');

  const pdfDoc = await PDFDocument.load(pdfBuffer);
  const pages = pdfDoc.getPages();
  if (!pages.length) throw new Error('PDF has no pages');

  const page = pages[0];
  const { width } = page.getSize();

  const png = await pdfDoc.embedPng(signaturePngBuffer);
  const sigWidth = 160;
  const sigHeight = (png.height / png.width) * sigWidth;
  const x = Math.max(24, width - sigWidth - 24);
  const y = 72; // 1 inch from bottom

  page.drawImage(png, { x, y, width: sigWidth, height: sigHeight });

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const textY = y + sigHeight + 8;
  const lines = [signatoryName, signatoryTitle].filter((v) => typeof v === 'string' && v.trim());
  let currY = textY;
  for (const line of lines) {
    page.drawText(line.trim(), {
      x,
      y: currY,
      size: 10,
      font,
      color: rgb(0.2, 0.2, 0.2),
    });
    currY += 12;
  }

  const out = await pdfDoc.save();
  return Buffer.from(out);
}

