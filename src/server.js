import express from 'express';
import { config } from './config/index.js';
import { logger } from './utils/logger.js';
import { loadExpress } from './loaders/express.load.js';
import { loadDatabase } from './loaders/sequelize.load.js';
import { initializeFirebase } from './config/firebase.js';

let server;

export const startServer = async () => {
  const app = express();

  try {
    // Initialize Firebase
    initializeFirebase();
    logger.info('Firebase initialized successfully');

    // Cargar DB
    await loadDatabase();

    // Cargar middlewares, rutas, JSON, CORS
    await loadExpress(app);

    server = app.listen(config.app.port, () => {
      logger.info(
        {
          port: config.app.port,
          env: config.app.nodeEnv,
        },
        `Server running on port ${config.app.port}`
      );
    });

    // Graceful shutdown
    setupGracefulShutdown();

    return server;
  } catch (error) {
    logger.error({ error }, 'Error starting the server');
    process.exit(1);
  }
};

const setupGracefulShutdown = () => {
  const shutdown = async (signal) => {
    logger.info({ signal }, 'Received shutdown signal, closing server...');

    if (server) {
      server.close(async () => {
        logger.info('HTTP server closed');

        // Cerrar conexiones de DB
        try {
          const { sequelize } = await import('./config/database.js');
          await sequelize.close();
          logger.info('Database connection closed');
        } catch (error) {
          logger.error({ error }, 'Error closing the database');
        }

        process.exit(0);
      });

      // Forzar cierre después de 10 segundos
      setTimeout(() => {
        logger.error('Force closing the server...');
        process.exit(1);
      }, 10000);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
};