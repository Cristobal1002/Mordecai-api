import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { routes } from '../routes/index.js';
import { responseHandler } from '../middlewares/index.js';
import { errorHandlerMiddleware } from '../middlewares/index.js';

export const loadExpress = async (app) => {
  // Security headers
  app.use(helmet());

  // CORS
  app.use(
    cors({
      origin: config.cors.origin === '*' ? true : config.cors.origin.split(','),
      credentials: config.cors.credentials,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'x-app-token'],
    })
  );

  // Body parsers
  app.use(express.json({ limit: '20mb' }));
  app.use(express.urlencoded({ extended: true, limit: '20mb' }));

  // Rate limiting
  const limiter = rateLimit({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.max,
    message: {
      success: false,
      message: 'Too many requests from this IP, try again later.',
    },
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use('/api/', limiter);

  // Request logging
  app.use((req, res, next) => {
    logger.info(
      {
        method: req.method,
        url: req.url,
        ip: req.ip,
      },
      'Incoming request'
    );
    next();
  });

  // Response handler middleware
  app.use(responseHandler);

  // Routes (async to handle conditional multi-tenant routes)
  await routes(app);

  // 404 handler
  app.use((req, res) => {
    res.notFound('Route not found');
  });

  // Error handler (debe ir al final)
  app.use(errorHandlerMiddleware.errorHandler);
};