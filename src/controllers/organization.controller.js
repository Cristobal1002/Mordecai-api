import { organizationService } from '../services/organization.service.js';
import { logger } from '../utils/logger.js';

class OrganizationController {
  
  /**
   * Create a new organization
   * POST /api/v1/organizations
   */
  async createOrganization(req, res, next) {
    try {
      const organizationData = req.body;
      const creatorUserId = req.user.id;
      
      const organization = await organizationService.createOrganization(organizationData, creatorUserId);
      
      res.success({
        message: 'Organization created successfully',
        data: {
          organization: {
            id: organization.id,
            name: organization.name,
            slug: organization.slug,
            description: organization.description,
            parentId: organization.parentId,
            settings: organization.settings,
            contactInfo: organization.contactInfo,
            isActive: organization.isActive,
            planType: organization.planType,
            createdAt: organization.createdAt,
          }
        }
      }, 201);
      
    } catch (error) {
      next(error);
    }
  }
  
  /**
   * Get user's organizations
   * GET /api/v1/organizations/my-organizations
   */
  async getUserOrganizations(req, res, next) {
    try {
      const userId = req.user.id;
      const includeInactive = req.query.includeInactive === 'true';
      
      const organizations = await organizationService.getUserOrganizations(userId, includeInactive);
      
      res.success({
        message: 'User organizations retrieved successfully',
        data: {
          organizations,
          count: organizations.length
        }
      });
      
    } catch (error) {
      next(error);
    }
  }
  
  /**
   * Get organization details
   * GET /api/v1/org/:tenantSlug
   */
  async getOrganization(req, res, next) {
    try {
      // Organization is already loaded by tenant middleware
      const organization = req.tenant;
      const membership = req.orgMembership;
      
      res.success({
        message: 'Organization retrieved successfully',
        data: {
          organization: {
            id: organization.id,
            name: organization.name,
            slug: organization.slug,
            description: organization.description,
            parentId: organization.parentId,
            settings: organization.settings,
            contactInfo: organization.contactInfo,
            isActive: organization.isActive,
            planType: organization.planType,
            foundedAt: organization.foundedAt,
            createdAt: organization.createdAt,
            updatedAt: organization.updatedAt,
          },
          membership: membership ? {
            role: membership.role,
            permissions: membership.permissions,
            joinedAt: membership.joinedAt,
            lastAccessAt: membership.lastAccessAt,
            department: membership.department,
            jobTitle: membership.jobTitle,
          } : null
        }
      });
      
    } catch (error) {
      next(error);
    }
  }
  
  /**
   * Update organization
   * PUT /api/v1/org/:tenantSlug
   */
  async updateOrganization(req, res, next) {
    try {
      const organizationId = req.tenant.id;
      const updateData = req.body;
      const userId = req.user.id;
      
      const organization = await organizationService.updateOrganization(organizationId, updateData, userId);
      
      res.success({
        message: 'Organization updated successfully',
        data: {
          organization: {
            id: organization.id,
            name: organization.name,
            slug: organization.slug,
            description: organization.description,
            settings: organization.settings,
            contactInfo: organization.contactInfo,
            updatedAt: organization.updatedAt,
          }
        }
      });
      
    } catch (error) {
      next(error);
    }
  }
  
  /**
   * Get organization hierarchy
   * GET /api/v1/org/:tenantSlug/hierarchy
   */
  async getOrganizationHierarchy(req, res, next) {
    try {
      const organizationId = req.tenant.id;
      const userId = req.user.id;
      
      const hierarchy = await organizationService.getOrganizationHierarchy(organizationId, userId);
      
      res.success({
        message: 'Organization hierarchy retrieved successfully',
        data: hierarchy
      });
      
    } catch (error) {
      next(error);
    }
  }
  
  /**
   * Get organization members
   * GET /api/v1/org/:tenantSlug/members
   */
  async getOrganizationMembers(req, res, next) {
    try {
      const organizationId = req.tenant.id;
      const userId = req.user.id;
      const options = {
        page: req.query.page,
        limit: req.query.limit,
        role: req.query.role,
        isActive: req.query.isActive !== undefined ? req.query.isActive === 'true' : undefined,
        search: req.query.search,
      };
      
      const result = await organizationService.getOrganizationMembers(organizationId, userId, options);
      
      res.success({
        message: 'Organization members retrieved successfully',
        data: result
      });
      
    } catch (error) {
      next(error);
    }
  }
  
  /**
   * Invite user to organization
   * POST /api/v1/org/:tenantSlug/members/invite
   */
  async inviteUser(req, res, next) {
    try {
      const organizationId = req.tenant.id;
      const inviteData = req.body;
      const inviterUserId = req.user.id;
      
      const membership = await organizationService.inviteUserToOrganization(
        organizationId, 
        inviteData, 
        inviterUserId
      );
      
      res.success({
        message: 'User invited to organization successfully',
        data: {
          membership: {
            id: membership.id,
            role: membership.role,
            permissions: membership.permissions,
            isActive: membership.isActive,
            invitedAt: membership.invitedAt,
            joinedAt: membership.joinedAt,
            department: membership.department,
            jobTitle: membership.jobTitle,
          }
        }
      }, 201);
      
    } catch (error) {
      next(error);
    }
  }
  
  /**
   * Remove user from organization
   * DELETE /api/v1/org/:tenantSlug/members/:userFirebaseUid
   */
  async removeUser(req, res, next) {
    try {
      const organizationId = req.tenant.id;
      const userFirebaseUid = req.params.userFirebaseUid;
      const removerUserId = req.user.id;
      
      await organizationService.removeUserFromOrganization(organizationId, userFirebaseUid, removerUserId);
      
      res.success({
        message: 'User removed from organization successfully'
      });
      
    } catch (error) {
      next(error);
    }
  }
  
  /**
   * Update user role in organization
   * PUT /api/v1/org/:tenantSlug/members/:userFirebaseUid/role
   */
  async updateUserRole(req, res, next) {
    try {
      const organizationId = req.tenant.id;
      const userFirebaseUid = req.params.userFirebaseUid;
      const { role } = req.body;
      const updaterUserId = req.user.id;
      
      const membership = await organizationService.updateUserRole(
        organizationId, 
        userFirebaseUid, 
        role, 
        updaterUserId
      );
      
      res.success({
        message: 'User role updated successfully',
        data: {
          membership: {
            id: membership.id,
            role: membership.role,
            permissions: membership.permissions,
            updatedAt: membership.updatedAt,
          }
        }
      });
      
    } catch (error) {
      next(error);
    }
  }
  
  /**
   * Get organization dashboard data
   * GET /api/v1/org/:tenantSlug/dashboard
   */
  async getDashboard(req, res, next) {
    try {
      const organization = req.tenant;
      const membership = req.orgMembership;
      const userId = req.user.id;
      
      // Get basic dashboard data
      const dashboardData = {
        organization: {
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
          planType: organization.planType,
          settings: organization.settings,
        },
        user: {
          role: membership?.role,
          permissions: membership?.permissions,
          joinedAt: membership?.joinedAt,
          lastAccessAt: membership?.lastAccessAt,
        },
        stats: {
          // These could be expanded with actual statistics
          totalMembers: 0,
          activeMembers: 0,
          subOrganizations: 0,
        }
      };
      
      // Get member count (basic stats)
      try {
        const memberStats = await organizationService.getOrganizationMembers(
          organization.id, 
          userId, 
          { limit: 1 }
        );
        dashboardData.stats.totalMembers = memberStats.pagination.total;
      } catch (error) {
        logger.warn({ error, organizationId: organization.id }, 'Could not get member stats for dashboard');
      }
      
      res.success({
        message: 'Dashboard data retrieved successfully',
        data: dashboardData
      });
      
    } catch (error) {
      next(error);
    }
  }
  
  /**
   * Get organization settings
   * GET /api/v1/org/:tenantSlug/settings
   */
  async getSettings(req, res, next) {
    try {
      const organization = req.tenant;
      
      res.success({
        message: 'Organization settings retrieved successfully',
        data: {
          settings: organization.settings,
          contactInfo: organization.contactInfo,
          planType: organization.planType,
          isActive: organization.isActive,
        }
      });
      
    } catch (error) {
      next(error);
    }
  }
  
  /**
   * Update organization settings
   * PUT /api/v1/org/:tenantSlug/settings
   */
  async updateSettings(req, res, next) {
    try {
      const organizationId = req.tenant.id;
      const { settings, contactInfo } = req.body;
      const userId = req.user.id;
      
      const updateData = {};
      if (settings) updateData.settings = settings;
      if (contactInfo) updateData.contactInfo = contactInfo;
      
      const organization = await organizationService.updateOrganization(organizationId, updateData, userId);
      
      res.success({
        message: 'Organization settings updated successfully',
        data: {
          settings: organization.settings,
          contactInfo: organization.contactInfo,
          updatedAt: organization.updatedAt,
        }
      });
      
    } catch (error) {
      next(error);
    }
  }
}

export const organizationController = new OrganizationController();
