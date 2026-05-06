import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import routes from '../routes/index.js';
import { responseHandler } from '../middlewares/index.js';
import { errorHandlerMiddleware } from '../middlewares/index.js';
import { swaggerOptions } from '../config/swagger.js';

export const loadExpress = (app) => {
  const normalizeOrigin = (origin) => origin.trim().replace(/\/+$/, '');
  const corsOrigins =
    config.cors.origin === '*'
      ? true
      : config.cors.origin
          .split(',')
          .map(normalizeOrigin)
          .filter(Boolean);

  // App Runner/ELB sits in front of the app, so trust proxy headers
  // for correct IP detection and to avoid express-rate-limit warnings.
  app.set('trust proxy', 1);
  // Security headers
  app.use(helmet());

  // CORS
  app.use(
    cors({
      origin: corsOrigins,
      credentials: config.cors.credentials,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'x-demo-token',
        'x-app-token',
        'x-csrf-token',
        'x-xsrf-token',
        'x-eleven-tool-secret',
      ],
    })
  );

  // Prevent 304 Not Modified for API: browser would get empty body and frontend treats 304 as error
  app.use('/api/', (req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    next();
  });

  // Body parsers
  app.use(
    express.json({
      limit: '20mb',
      verify: (req, _res, buf) => {
        if (buf?.length) {
          req.rawBody = buf.toString('utf8');
        }
      },
    })
  );
  app.use(express.urlencoded({ extended: true, limit: '20mb' }));

  // Rate limiting - más estricto para prevenir abuso
  const limiter = rateLimit({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.max,
    message: {
      success: false,
      message: 'Too many requests from this IP, try again later.',
    },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      logger.warn(
        {
          method: req.method,
          url: req.url,
          ip: req.ip,
        },
        'Rate limit exceeded'
      );
      res.status(429).json({
        success: false,
        message: 'Too many requests from this IP, try again later.',
      });
    },
    skip: (req) => {
      // No aplicar rate limiting a health checks, WebSocket stream de Twilio
      // ni webhooks de post-llamada de ElevenLabs.
      return (
        req.url.includes('/health') ||
        req.url.includes('/twilio/stream') ||
        req.url.includes('/twilio/voice') ||
        req.url.includes('/twilio/sms-status') ||
        req.url.includes('/twilio/sms/link-click') ||
        req.url.includes('/twilio/voice/status') ||
        req.url.includes('/eleven/post-call')
      );
    },
  });

  app.use('/api/', limiter);
  
  // Middleware para detectar y limitar peticiones repetidas a rutas inexistentes
  const recent404s = new Map();
  app.use('/api/', (req, res, next) => {
    const key = `${req.ip}:${req.url}`;
    const now = Date.now();
    const recent = recent404s.get(key) || [];
    
    // Limpiar entradas antiguas (más de 1 minuto)
    const filtered = recent.filter((time) => now - time < 60000);
    
    // Si hay más de 5 peticiones 404 a la misma ruta en 1 minuto, bloquear
    if (filtered.length >= 5) {
      logger.warn(
        {
          method: req.method,
          url: req.url,
          ip: req.ip,
          count: filtered.length,
        },
        'Blocking repeated 404 requests'
      );
      return res.status(429).json({
        success: false,
        message: 'Too many requests to non-existent route. Please check your API endpoint.',
      });
    }
    
    // Guardar referencia para verificar después si fue 404
    res.on('finish', () => {
      if (res.statusCode === 404) {
        filtered.push(now);
        recent404s.set(key, filtered);
      }
    });
    
    next();
  });

  // Request logging - después del rate limiting para no saturar logs
  // Incluye información detallada para identificar el origen de las peticiones
  app.use((req, res, next) => {
    const logData = {
      method: req.method,
      url: req.url,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      referer: req.get('referer'),
      origin: req.get('origin'),
      host: req.get('host'),
      // Solo loggear headers adicionales si están presentes para no saturar
      ...(req.get('x-forwarded-for') && { forwardedFor: req.get('x-forwarded-for') }),
      ...(req.get('authorization') && { hasAuth: !!req.get('authorization') }),
    };
    
    const logLevel = 'info';
    const logMessage = 'Incoming request';
    
    logger[logLevel](logData, logMessage);
    next();
  });

  // Response handler middleware
  app.use(responseHandler);

  // Swagger only in development
  if (config.app.nodeEnv === 'development') {
    // Swagger (UI + JSON)
    const swaggerCustomCss = `
    .swagger-ui .opblock-tag small {
      display: block !important;
      margin-top: 4px !important;
    }
    .swagger-ui .opblock-tag a {
      display: block !important;
    }
    .swagger-ui .opblock-tag {
      display: block !important;
    }
    `;

    const swaggerSpec = swaggerJsdoc(swaggerOptions);

    app.use(
      `/api/${config.app.apiVersion}/docs`,
      swaggerUi.serve,
      swaggerUi.setup(swaggerSpec, {
        explorer: true,
        customCss: swaggerCustomCss,
      })
    );

    app.get(`/api/${config.app.apiVersion}/docs.json`, (req, res) => {
      res.json(swaggerSpec);
    });
  }

  // Routes
  routes(app);

  // 404 handler
  app.use((req, res) => {
    res.notFound('Route not found');
  });

  // Error handler (debe ir al final)
  app.use(errorHandlerMiddleware.errorHandler);
};
