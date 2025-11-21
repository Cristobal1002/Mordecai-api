import { Organization, OrganizationUser } from '../models/index.js';
import { AuthenticationError, ValidationError } from '../errors/index.js';
import { logger } from '../utils/logger.js';

/**
 * Tenant middleware - Adds organization context to requests
 * MUST be used AFTER authenticate middleware (requires req.user from Firebase)
 */
export const tenantMiddleware = async (req, res, next) => {
  try {
    // Ensure user is authenticated by Firebase first
    if (!req.user) {
      throw new AuthenticationError('Authentication required before tenant context');
    }

    // Extract tenant identifier from various sources
    const tenantSlug = extractTenantIdentifier(req);

    if (!tenantSlug) {
      return res.error('Organization context required', 400, {
        code: 'TENANT_REQUIRED',
        details: 'Provide organization via header, subdomain, or URL parameter'
      });
    }

    // Find the organization
    const organization = await Organization.findOne({
      where: { 
        slug: tenantSlug,
        isActive: true 
      }
    });

    if (!organization) {
      return res.error('Organization not found or inactive', 404, {
        code: 'ORGANIZATION_NOT_FOUND',
        details: `Organization '${tenantSlug}' does not exist or is inactive`
      });
    }

    // Check if user has access to this organization
    const hasAccess = await checkUserAccess(req.user, organization.id);
    
    if (!hasAccess) {
      return res.error('Access denied to this organization', 403, {
        code: 'ORGANIZATION_ACCESS_DENIED',
        details: `User does not have access to organization '${tenantSlug}'`
      });
    }

    // Get user's membership details
    const membership = await OrganizationUser.findOne({
      where: {
        userId: req.user.id,
        organizationId: organization.id,
        isActive: true,
      },
    });

    // Add tenant context to request
    req.tenant = organization;
    req.tenantId = organization.id;
    req.tenantSlug = organization.slug;
    req.orgMembership = membership;
    req.orgRole = membership ? membership.role : null;
    req.orgPermissions = membership ? membership.permissions : {};

    // Update last access time (async, don't wait)
    if (membership) {
      membership.updateLastAccess().catch(error => {
        logger.warn({ error, userId: req.user.id, orgId: organization.id }, 
          'Failed to update last access time');
      });
    }

    // Log tenant access for audit
    logger.debug({
      userId: req.user.id,
      firebaseUid: req.user.firebaseUid,
      organizationId: organization.id,
      organizationSlug: organization.slug,
      role: req.orgRole,
    }, 'Tenant context established');

    next();
  } catch (error) {
    logger.error({ error, userId: req.user?.id }, 'Error in tenant middleware');
    next(error);
  }
};

/**
 * Optional tenant middleware - Adds tenant context if available, but doesn't require it
 */
export const optionalTenantMiddleware = async (req, res, next) => {
  try {
    // Skip if no user authenticated
    if (!req.user) {
      return next();
    }

    const tenantSlug = extractTenantIdentifier(req);
    
    // Skip if no tenant identifier provided
    if (!tenantSlug) {
      return next();
    }

    // Try to find organization and add context if available
    const organization = await Organization.findOne({
      where: { 
        slug: tenantSlug,
        isActive: true 
      }
    });

    if (organization) {
      const hasAccess = await checkUserAccess(req.user, organization.id);
      
      if (hasAccess) {
        const membership = await OrganizationUser.findOne({
          where: {
            userId: req.user.id,
            organizationId: organization.id,
            isActive: true,
          },
        });

        req.tenant = organization;
        req.tenantId = organization.id;
        req.tenantSlug = organization.slug;
        req.orgMembership = membership;
        req.orgRole = membership ? membership.role : null;
        req.orgPermissions = membership ? membership.permissions : {};
      }
    }

    next();
  } catch (error) {
    // For optional middleware, log error but continue
    logger.warn({ error, userId: req.user?.id }, 'Warning in optional tenant middleware');
    next();
  }
};

/**
 * Middleware to require specific organization roles
 */
export const requireOrgRole = (allowedRoles) => {
  if (!Array.isArray(allowedRoles)) {
    allowedRoles = [allowedRoles];
  }

  return async (req, res, next) => {
    try {
      // Ensure tenant context exists
      if (!req.tenant || !req.user) {
        return res.error('Organization context required', 401, {
          code: 'TENANT_CONTEXT_REQUIRED'
        });
      }

      // Super admins bypass role checks
      if (req.user.isSuperAdmin()) {
        return next();
      }

      // Check organization role
      if (!req.orgRole || !allowedRoles.includes(req.orgRole)) {
        return res.error('Insufficient organization permissions', 403, {
          code: 'INSUFFICIENT_ORG_PERMISSIONS',
          details: `Required roles: ${allowedRoles.join(', ')}, current role: ${req.orgRole || 'none'}`
        });
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};

/**
 * Middleware to require specific organization permissions
 */
export const requireOrgPermission = (resource, action) => {
  return async (req, res, next) => {
    try {
      // Ensure tenant context exists
      if (!req.tenant || !req.user || !req.orgMembership) {
        return res.error('Organization context required', 401, {
          code: 'TENANT_CONTEXT_REQUIRED'
        });
      }

      // Super admins bypass permission checks
      if (req.user.isSuperAdmin()) {
        return next();
      }

      // Check specific permission
      if (!req.orgMembership.hasPermission(resource, action)) {
        return res.error('Insufficient organization permissions', 403, {
          code: 'INSUFFICIENT_ORG_PERMISSIONS',
          details: `Required permission: ${resource}.${action}`
        });
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};

/**
 * Extract tenant identifier from request
 */
function extractTenantIdentifier(req) {
  // Priority order:
  // 1. URL parameter (highest priority)
  // 2. Header
  // 3. Subdomain
  
  // From URL parameter
  if (req.params.tenantSlug) {
    return req.params.tenantSlug;
  }
  
  if (req.params.orgSlug) {
    return req.params.orgSlug;
  }

  // From header
  const headerTenant = req.headers['x-tenant-id'] || req.headers['x-organization-slug'];
  if (headerTenant) {
    return headerTenant;
  }

  // From subdomain
  const host = req.get('host');
  if (host) {
    const subdomain = extractSubdomain(host);
    if (subdomain && subdomain !== 'www' && subdomain !== 'api') {
      return subdomain;
    }
  }

  return null;
}

/**
 * Extract subdomain from host
 */
function extractSubdomain(host) {
  const parts = host.split('.');
  if (parts.length >= 3) {
    return parts[0];
  }
  return null;
}

/**
 * Check if user has access to organization
 */
async function checkUserAccess(user, organizationId) {
  // Super admins have access to all organizations
  if (user.isSuperAdmin()) {
    return true;
  }

  // Check organization membership
  const membership = await OrganizationUser.findOne({
    where: {
      userId: user.id,
      organizationId,
      isActive: true,
    },
  });

  return !!membership;
}

/**
 * Utility function to get user's organizations (for route handlers)
 */
export const getUserOrganizations = async (userId) => {
  try {
    const memberships = await OrganizationUser.findAll({
      where: {
        userId,
        isActive: true,
      },
      include: [{
        model: Organization,
        as: 'Organization',
        where: { isActive: true },
      }],
      order: [['joinedAt', 'DESC']],
    });

    return memberships.map(membership => ({
      organization: membership.Organization,
      role: membership.role,
      permissions: membership.permissions,
      joinedAt: membership.joinedAt,
      lastAccessAt: membership.lastAccessAt,
    }));
  } catch (error) {
    logger.error({ error, userId }, 'Error getting user organizations');
    return [];
  }
};

/**
 * Utility function to check if user can perform action in organization
 */
export const canUserPerformAction = async (userId, organizationId, resource, action) => {
  try {
    const user = await User.findByPk(userId);
    if (!user) return false;

    // Super admins can do anything
    if (user.isSuperAdmin()) {
      return true;
    }

    const membership = await OrganizationUser.findOne({
      where: {
        userId,
        organizationId,
        isActive: true,
      },
    });

    if (!membership) return false;

    return membership.hasPermission(resource, action);
  } catch (error) {
    logger.error({ error, userId, organizationId, resource, action }, 
      'Error checking user permissions');
    return false;
  }
};
