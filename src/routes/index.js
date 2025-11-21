import { config } from '../config/index.js';
import { health } from './health.route.js';
import { auth } from './auth.route.js';
import { user } from './user.route.js';

export const routes = (server) => {
  // Core routes (always available)
  server.use(`/api/${config.app.apiVersion}/health`, health);
  server.use(`/api/${config.app.apiVersion}/auth`, auth);
  server.use(`/api/${config.app.apiVersion}/users`, user);
  
  // Multi-tenant routes (only if feature is enabled)
  if (config.features.multiTenant) {
    import('./organization.route.js').then(({ default: organizationRoutes }) => {
      server.use(`/api/${config.app.apiVersion}/organizations`, organizationRoutes);
      
      // Alternative route pattern for tenant-specific endpoints
      // This allows both /organizations/:slug and /org/:slug patterns
      server.use(`/api/${config.app.apiVersion}/org`, organizationRoutes);
    }).catch(error => {
      console.warn('Multi-tenant routes not available:', error.message);
    });
  }
};