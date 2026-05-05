import Anthropic from '@anthropic-ai/sdk';
import { PDFParse } from 'pdf-parse';
import { config } from '../../config/index.js';
import { BadRequestError, ServiceUnavailableError } from '../../errors/http.error.js';

const MAX_PDF_TEXT = 14_000;
const MAX_TOKENS = 4096;

const SYSTEM_PROMPT = `You help property managers draft collection / notice letters as HTML for a PDF pipeline.

Rules:
- Output ONLY a fragment of HTML (no <!DOCTYPE>, no <html>, no <body>, no markdown fences).
- Use simple tags: p, br, h2, h3, ul, ol, li, strong, em, a (href only to https URLs if needed).
- Do NOT use script, style, iframe, object, embed, or inline event handlers.
- Use these merge fields exactly when relevant (double curly braces): {{tenant_name}}, {{debtor_name}}, {{amount_due}}, {{days_past_due}}, {{due_date}}, {{letter_date}}, {{payment_link}}, {{property_name}}, {{property_address}}, {{debtor_address}}, {{unit_number}}, {{lease_number}}.
- Include the signature anchor exactly once where the authorized signature should appear (usually after the closing paragraph and before names), as this exact HTML comment on its own line:
<!-- {{SIGNATURE_BLOCK}} -->
- Write the letter in English unless the user explicitly asks for another language in their instructions.
- Keep a professional, compliant tone; do not invent legal citations unless the user supplied them in reference material.`;

function stripCodeFences(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^```(?:html)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  return s.trim();
}

function sanitizeDraftHtml(html) {
  let s = stripCodeFences(html);
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  return s.trim();
}

/**
 * @param {InstanceType<typeof Anthropic.APIError>} err
 * @param {string} modelId
 */
function mapAnthropicSdkError(err, modelId) {
  const status = err?.status;
  const body = err?.error;
  const nested = body && typeof body === 'object' ? body.error : null;
  const apiMsg = nested && typeof nested.message === 'string' ? nested.message : '';
  const apiType = nested && typeof nested.type === 'string' ? nested.type : '';

  const isModelNotFound =
    status === 404 &&
    (apiType === 'not_found_error' || /model:/i.test(apiMsg) || /model not found/i.test(apiMsg));

  if (isModelNotFound) {
    return new BadRequestError(
      `Claude model "${modelId}" is not available for this API key (deprecated or invalid). Set CLAUDE_MODEL in the server environment to a current ID such as claude-sonnet-4-6. See Anthropic model docs.`
    );
  }
  if (status === 401) {
    return new BadRequestError('Anthropic rejected the API key. Check ANTHROPIC_API_KEY.');
  }
  if (status === 403) {
    return new BadRequestError('Anthropic denied this request. Verify API key permissions and organization access.');
  }
  if (status === 429) {
    return new ServiceUnavailableError('Claude rate limit reached. Try again in a moment.');
  }
  if (status != null && status >= 500) {
    return new ServiceUnavailableError('Claude is temporarily unavailable. Try again later.');
  }
  if (status === 400 && apiMsg) {
    return new BadRequestError(apiMsg);
  }
  return new ServiceUnavailableError('Could not complete the AI draft request.');
}

async function extractPdfText(buffer) {
  let parser;
  try {
    parser = new PDFParse({ data: buffer });
    const data = await parser.getText();
    const text = (data?.text || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return text.length > MAX_PDF_TEXT ? `${text.slice(0, MAX_PDF_TEXT)}\n…` : text;
  } catch {
    return '';
  } finally {
    try {
      await parser?.destroy?.();
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {{ prompt: string, file?: Express.Multer.File | null }} opts
 * @returns {Promise<{ bodyHtml: string }>}
 */
export async function draftLetterHtmlWithClaude({ prompt, file }) {
  const apiKey = config.anthropic?.apiKey;
  if (!apiKey) {
    throw new ServiceUnavailableError('Letter AI is not configured (set ANTHROPIC_API_KEY).');
  }

  const model = config.anthropic?.model || 'claude-sonnet-4-6';
  const client = new Anthropic({ apiKey });

  /** @type {import('@anthropic-ai/sdk').Anthropic.Messages.MessageCreateParamsNonStreaming['messages'][0]['content']} */
  const content = [];

  if (file?.buffer?.length) {
    const mime = file.mimetype || '';
    if (mime === 'application/pdf') {
      const pdfText = await extractPdfText(file.buffer);
      if (pdfText) {
        content.push({
          type: 'text',
          text: `Reference document (extracted from PDF):\n---\n${pdfText}\n---`,
        });
      } else {
        content.push({
          type: 'text',
          text:
            'The user attached a PDF but no text could be extracted (it may be image-only). Output a concise English collection-letter template with merge fields and the SIGNATURE_BLOCK comment, and one paragraph suggesting they upload an image or add more instructions next time.',
        });
      }
    } else if (mime.startsWith('image/')) {
      const base64 = file.buffer.toString('base64');
      const mediaType =
        mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/gif' || mime === 'image/webp'
          ? mime
          : 'image/png';
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data: base64 },
      });
    }
  }

  const userText =
    prompt.trim() ||
    'Turn the attached reference into a formal collection letter HTML body with merge fields where appropriate. Include the SIGNATURE_BLOCK comment once.';

  content.push({
    type: 'text',
    text: userText,
  });

  let message;
  try {
    message = await client.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
    });
  } catch (e) {
    if (e instanceof Anthropic.APIError) {
      throw mapAnthropicSdkError(e, model);
    }
    throw e;
  }

  const textBlocks = (message.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  const bodyHtml = sanitizeDraftHtml(textBlocks);
  if (!bodyHtml) {
    throw new BadRequestError('The model returned empty content. Try again with a clearer prompt.');
  }

  return { bodyHtml };
}
