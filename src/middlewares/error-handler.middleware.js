import { CustomError } from '../errors/index.js';
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';

export const errorHandler = (err, req, res, _next) => {
  // Log del error
  logger.error(
    {
      error: {
        name: err.name,
        message: err.message,
        stack: err.stack,
      },
      request: {
        method: req.method,
        url: req.url,
        ip: req.ip,
        body: req.body,
      },
    },
    'Error capturado'
  );

  if (err instanceof CustomError) {
    const serialized = err.serialize();
    return res.status(err.statusCode).json(serialized);
  }

  // JSON malformado en el body (body-parser / express.json())
  const status = err.status ?? err.statusCode;
  const isJsonParseError =
    err instanceof SyntaxError ||
    (status === 400 && (err.type === 'entity.parse.failed' || /JSON/i.test(String(err.message))));
  if (isJsonParseError) {
    return res.status(400).json({
      success: false,
      message: 'Invalid JSON in request body',
      details: config.app.nodeEnv === 'development' ? { parseError: err.message } : undefined,
    });
  }

  // Redis/Upstash rate limit (queue unavailable or max requests exceeded)
  const errMsg = String(err?.message ?? '');
  const isRedisRateLimit =
    /max requests limit exceeded/i.test(errMsg) ||
    /upstash.*limit/i.test(errMsg) ||
    /ERR.*limit/i.test(errMsg);
  if (isRedisRateLimit) {
    return res.status(503).json({
      type: 'https://mordecai.com/errors/queue-unavailable',
      title: 'Queue service temporarily unavailable',
      status: 503,
      details: {
        message:
          'The queue service has reached its request limit. Please try again later or upgrade your Redis/Upstash plan.',
        ...(config.app.nodeEnv === 'development' && { originalError: errMsg }),
      },
    });
  }

  // Puppeteer PDF (e.g. preview-pdf): setContent/navigation timeout — often external assets or heavy HTML
  const isPuppeteerTimeout =
    err.name === 'TimeoutError' &&
    /Navigation timeout|timeout.*exceeded|Waiting failed/i.test(errMsg);
  if (isPuppeteerTimeout) {
    return res.status(504).json({
      type: 'https://mordecai.com/errors/pdf-render-timeout',
      title: 'PDF preview timed out',
      status: 504,
      details: {
        message:
          'Rendering the PDF took too long. Remove or fix slow external images/links in the letter, or increase PUPPETEER_SET_CONTENT_TIMEOUT_MS on the server.',
        ...(config.app.nodeEnv === 'development' && { originalError: errMsg }),
      },
    });
  }

  // Error no manejado: mensaje genérico al cliente; en desarrollo se incluye el mensaje real (nunca el stack)
  return res.status(500).json({
    type: 'about:blank',
    title: 'Internal server error',
    status: 500,
    details: {
      message:
        config.app.nodeEnv === 'development'
          ? err.message
          : 'An internal server error occurred',
    },
  });
};