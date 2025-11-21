import { Op } from 'sequelize';
import { sequelize, User, Organization, OrganizationUser } from '../models/index.js';
import { AuthenticationError, ValidationError, ConflictError } from '../errors/index.js';
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';

class OrganizationService {
  
  /**
   * Create a new organization
   */
  async createOrganization(organizationData, creatorUserId) {
    const transaction = await sequelize.transaction();
    
    try {
      const { name, slug, description, parentId, settings = {}, contactInfo = {} } = organizationData;
      
      // Validate creator exists and is active
      const creator = await User.findByPk(creatorUserId, { transaction });
      if (!creator || !creator.isActive) {
        throw new AuthenticationError('Creator user not found or inactive');
      }
      
      // Check if user can create organizations
      if (!config.tenant.allowOrgCreation && !creator.isSystemAdmin()) {
        throw new AuthenticationError('Organization creation is not allowed');
      }
      
      // Check user's organization limit
      const userOrgCount = await OrganizationUser.count({
        where: { 
          userId: creatorUserId, 
          role: 'owner',
          isActive: true 
        },
        transaction
      });
      
      if (userOrgCount >= config.tenant.maxOrgsPerUser && !creator.isSystemAdmin()) {
        throw new ValidationError(`Maximum organizations limit reached (${config.tenant.maxOrgsPerUser})`);
      }
      
      // Validate parent organization if specified
      let parentOrg = null;
      if (parentId) {
        parentOrg = await Organization.findByPk(parentId, { transaction });
        if (!parentOrg || !parentOrg.isActive) {
          throw new ValidationError('Parent organization not found or inactive');
        }
        
        // Check if user has admin access to parent organization
        const hasParentAccess = await this.userCanManageOrganization(creatorUserId, parentId, transaction);
        if (!hasParentAccess && !creator.isSystemAdmin()) {
          throw new AuthenticationError('Insufficient permissions to create sub-organization');
        }
      }
      
      // Create the organization
      const organization = await Organization.create({
        name,
        slug,
        description,
        parentId,
        settings: {
          ...Organization.rawAttributes.settings.defaultValue,
          ...settings
        },
        contactInfo,
        isActive: true,
        planType: 'free',
        foundedAt: new Date(),
      }, { transaction });
      
      // Make creator the owner of the organization
      await OrganizationUser.create({
        userId: creatorUserId,
        organizationId: organization.id,
        role: 'owner',
        isActive: true,
        joinedAt: new Date(),
        invitedBy: null, // Self-created
      }, { transaction });
      
      await transaction.commit();
      
      logger.info({
        organizationId: organization.id,
        organizationSlug: organization.slug,
        creatorId: creatorUserId,
        parentId
      }, 'Organization created successfully');
      
      return organization;
      
    } catch (error) {
      await transaction.rollback();
      logger.error({ error, organizationData, creatorUserId }, 'Error creating organization');
      throw error;
    }
  }
  
  /**
   * Get organization by ID or slug
   */
  async getOrganization(identifier, userId = null) {
    try {
      const where = {};
      
      // Check if identifier is UUID or slug
      if (identifier.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
        where.id = identifier;
      } else {
        where.slug = identifier;
      }
      
      where.isActive = true;
      
      const organization = await Organization.findOne({
        where,
        include: [
          {
            model: Organization,
            as: 'ParentOrganization',
            attributes: ['id', 'name', 'slug']
          },
          {
            model: Organization,
            as: 'SubOrganizations',
            where: { isActive: true },
            required: false,
            attributes: ['id', 'name', 'slug', 'description']
          }
        ]
      });
      
      if (!organization) {
        throw new ValidationError('Organization not found');
      }
      
      // Check user access if userId provided
      if (userId) {
        const hasAccess = await this.userHasOrganizationAccess(userId, organization.id);
        if (!hasAccess) {
          throw new AuthenticationError('Access denied to this organization');
        }
      }
      
      return organization;
      
    } catch (error) {
      logger.error({ error, identifier, userId }, 'Error getting organization');
      throw error;
    }
  }
  
  /**
   * Update organization
   */
  async updateOrganization(organizationId, updateData, userId) {
    const transaction = await sequelize.transaction();
    
    try {
      // Check user permissions
      const canManage = await this.userCanManageOrganization(userId, organizationId, transaction);
      if (!canManage) {
        throw new AuthenticationError('Insufficient permissions to update organization');
      }
      
      const organization = await Organization.findByPk(organizationId, { transaction });
      if (!organization) {
        throw new ValidationError('Organization not found');
      }
      
      // Update allowed fields
      const allowedFields = ['name', 'description', 'settings', 'contactInfo'];
      const updateFields = {};
      
      allowedFields.forEach(field => {
        if (updateData[field] !== undefined) {
          updateFields[field] = updateData[field];
        }
      });
      
      // Special handling for settings (merge with existing)
      if (updateData.settings) {
        updateFields.settings = {
          ...organization.settings,
          ...updateData.settings
        };
      }
      
      await organization.update(updateFields, { transaction });
      await transaction.commit();
      
      logger.info({
        organizationId,
        userId,
        updatedFields: Object.keys(updateFields)
      }, 'Organization updated successfully');
      
      return organization;
      
    } catch (error) {
      await transaction.rollback();
      logger.error({ error, organizationId, updateData, userId }, 'Error updating organization');
      throw error;
    }
  }
  
  /**
   * Get user's organizations
   */
  async getUserOrganizations(userId, includeInactive = false) {
    try {
      const user = await User.findByPk(userId);
      if (!user) {
        throw new AuthenticationError('User not found');
      }
      
      // Super admins can see all organizations
      if (user.isSuperAdmin()) {
        return await Organization.findAll({
          where: includeInactive ? {} : { isActive: true },
          include: [
            {
              model: Organization,
              as: 'ParentOrganization',
              attributes: ['id', 'name', 'slug']
            }
          ],
          order: [['name', 'ASC']]
        });
      }
      
      // Regular users see only their organizations
      const memberships = await OrganizationUser.findAll({
        where: {
          userId,
          isActive: includeInactive ? undefined : true
        },
        include: [
          {
            model: Organization,
            as: 'Organization',
            where: { isActive: true },
            include: [
              {
                model: Organization,
                as: 'ParentOrganization',
                attributes: ['id', 'name', 'slug']
              }
            ]
          }
        ],
        order: [['joinedAt', 'DESC']]
      });
      
      return memberships.map(membership => ({
        ...membership.Organization.toJSON(),
        membership: {
          role: membership.role,
          permissions: membership.permissions,
          joinedAt: membership.joinedAt,
          lastAccessAt: membership.lastAccessAt,
          isActive: membership.isActive
        }
      }));
      
    } catch (error) {
      logger.error({ error, userId }, 'Error getting user organizations');
      throw error;
    }
  }
  
  /**
   * Get organization members
   */
  async getOrganizationMembers(organizationId, userId, options = {}) {
    try {
      // Check user permissions
      const canView = await this.userHasOrganizationAccess(userId, organizationId);
      if (!canView) {
        throw new AuthenticationError('Access denied to this organization');
      }
      
      const { page = 1, limit = 20, role, isActive, search } = options;
      const offset = (page - 1) * limit;
      
      const where = { organizationId };
      if (role) where.role = role;
      if (isActive !== undefined) where.isActive = isActive;
      
      const include = [
        {
          model: User,
          as: 'User',
          where: { isActive: true },
          attributes: ['id', 'firebaseUid', 'displayName', 'systemRole', 'isActive', 'lastLoginAt']
        }
      ];
      
      // Add search if provided
      if (search) {
        include[0].where = {
          ...include[0].where,
          [Op.or]: [
            { displayName: { [Op.iLike]: `%${search}%` } },
            { firebaseUid: { [Op.iLike]: `%${search}%` } }
          ]
        };
      }
      
      const { rows: memberships, count } = await OrganizationUser.findAndCountAll({
        where,
        include,
        limit: parseInt(limit),
        offset: parseInt(offset),
        order: [['joinedAt', 'ASC']]
      });
      
      return {
        members: memberships.map(membership => ({
          id: membership.id,
          user: membership.User,
          role: membership.role,
          permissions: membership.permissions,
          isActive: membership.isActive,
          joinedAt: membership.joinedAt,
          lastAccessAt: membership.lastAccessAt,
          department: membership.department,
          jobTitle: membership.jobTitle
        })),
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: count,
          pages: Math.ceil(count / limit)
        }
      };
      
    } catch (error) {
      logger.error({ error, organizationId, userId }, 'Error getting organization members');
      throw error;
    }
  }
  
  /**
   * Invite user to organization
   */
  async inviteUserToOrganization(organizationId, inviteData, inviterUserId) {
    const transaction = await sequelize.transaction();
    
    try {
      const { userFirebaseUid, role = 'employee', permissions = {}, department, jobTitle } = inviteData;
      
      // Check inviter permissions
      const canInvite = await this.userCanInviteToOrganization(inviterUserId, organizationId, transaction);
      if (!canInvite) {
        throw new AuthenticationError('Insufficient permissions to invite users');
      }
      
      // Find the user to invite
      const userToInvite = await User.findOne({
        where: { firebaseUid: userFirebaseUid, isActive: true },
        transaction
      });
      
      if (!userToInvite) {
        throw new ValidationError('User not found or inactive');
      }
      
      // Check if user is already a member
      const existingMembership = await OrganizationUser.findOne({
        where: {
          userId: userToInvite.id,
          organizationId,
        },
        paranoid: false, // Include soft-deleted
        transaction
      });
      
      if (existingMembership) {
        if (existingMembership.isActive) {
          throw new ConflictError('User is already a member of this organization');
        } else {
          // Reactivate soft-deleted membership
          await existingMembership.update({
            role,
            permissions: {
              ...OrganizationUser.getRolePermissions(role),
              ...permissions
            },
            isActive: true,
            invitedBy: inviterUserId,
            invitedAt: new Date(),
            department,
            jobTitle
          }, { transaction });
          
          await transaction.commit();
          return existingMembership;
        }
      }
      
      // Create new membership
      const membership = await OrganizationUser.create({
        userId: userToInvite.id,
        organizationId,
        role,
        permissions: {
          ...OrganizationUser.getRolePermissions(role),
          ...permissions
        },
        isActive: true,
        invitedBy: inviterUserId,
        invitedAt: new Date(),
        joinedAt: new Date(),
        department,
        jobTitle
      }, { transaction });
      
      await transaction.commit();
      
      logger.info({
        organizationId,
        invitedUserId: userToInvite.id,
        inviterUserId,
        role
      }, 'User invited to organization successfully');
      
      return membership;
      
    } catch (error) {
      await transaction.rollback();
      logger.error({ error, organizationId, inviteData, inviterUserId }, 'Error inviting user to organization');
      throw error;
    }
  }
  
  /**
   * Remove user from organization
   */
  async removeUserFromOrganization(organizationId, userFirebaseUid, removerUserId) {
    const transaction = await sequelize.transaction();
    
    try {
      // Check remover permissions
      const canRemove = await this.userCanManageMembers(removerUserId, organizationId, transaction);
      if (!canRemove) {
        throw new AuthenticationError('Insufficient permissions to remove users');
      }
      
      // Find user to remove
      const userToRemove = await User.findOne({
        where: { firebaseUid: userFirebaseUid },
        transaction
      });
      
      if (!userToRemove) {
        throw new ValidationError('User not found');
      }
      
      // Find membership
      const membership = await OrganizationUser.findOne({
        where: {
          userId: userToRemove.id,
          organizationId,
          isActive: true
        },
        transaction
      });
      
      if (!membership) {
        throw new ValidationError('User is not a member of this organization');
      }
      
      // Prevent removing the last owner
      if (membership.role === 'owner') {
        const ownerCount = await OrganizationUser.count({
          where: {
            organizationId,
            role: 'owner',
            isActive: true,
            id: { [Op.ne]: membership.id }
          },
          transaction
        });
        
        if (ownerCount === 0) {
          throw new ValidationError('Cannot remove the last owner of the organization');
        }
      }
      
      // Soft delete the membership
      await membership.destroy({ transaction });
      
      await transaction.commit();
      
      logger.info({
        organizationId,
        removedUserId: userToRemove.id,
        removerUserId,
        role: membership.role
      }, 'User removed from organization successfully');
      
      return true;
      
    } catch (error) {
      await transaction.rollback();
      logger.error({ error, organizationId, userFirebaseUid, removerUserId }, 'Error removing user from organization');
      throw error;
    }
  }
  
  /**
   * Update user role in organization
   */
  async updateUserRole(organizationId, userFirebaseUid, newRole, updaterUserId) {
    const transaction = await sequelize.transaction();
    
    try {
      // Check updater permissions
      const canUpdate = await this.userCanManageMembers(updaterUserId, organizationId, transaction);
      if (!canUpdate) {
        throw new AuthenticationError('Insufficient permissions to update user roles');
      }
      
      // Find user
      const user = await User.findOne({
        where: { firebaseUid: userFirebaseUid },
        transaction
      });
      
      if (!user) {
        throw new ValidationError('User not found');
      }
      
      // Find membership
      const membership = await OrganizationUser.findOne({
        where: {
          userId: user.id,
          organizationId,
          isActive: true
        },
        transaction
      });
      
      if (!membership) {
        throw new ValidationError('User is not a member of this organization');
      }
      
      // Prevent changing the last owner
      if (membership.role === 'owner' && newRole !== 'owner') {
        const ownerCount = await OrganizationUser.count({
          where: {
            organizationId,
            role: 'owner',
            isActive: true,
            id: { [Op.ne]: membership.id }
          },
          transaction
        });
        
        if (ownerCount === 0) {
          throw new ValidationError('Cannot change role of the last owner');
        }
      }
      
      // Update role (permissions will be updated automatically by hook)
      await membership.update({ role: newRole }, { transaction });
      
      await transaction.commit();
      
      logger.info({
        organizationId,
        userId: user.id,
        oldRole: membership.role,
        newRole,
        updaterUserId
      }, 'User role updated successfully');
      
      return membership;
      
    } catch (error) {
      await transaction.rollback();
      logger.error({ error, organizationId, userFirebaseUid, newRole, updaterUserId }, 'Error updating user role');
      throw error;
    }
  }
  
  /**
   * Get organization hierarchy
   */
  async getOrganizationHierarchy(organizationId, userId) {
    try {
      // Check user access
      const hasAccess = await this.userHasOrganizationAccess(userId, organizationId);
      if (!hasAccess) {
        throw new AuthenticationError('Access denied to this organization');
      }
      
      const organization = await Organization.findByPk(organizationId, {
        include: [
          {
            model: Organization,
            as: 'SubOrganizations',
            where: { isActive: true },
            required: false,
            include: [
              {
                model: User,
                as: 'Members',
                through: { 
                  attributes: ['role'],
                  where: { isActive: true }
                },
                attributes: ['id', 'displayName']
              }
            ]
          },
          {
            model: Organization,
            as: 'ParentOrganization',
            attributes: ['id', 'name', 'slug']
          }
        ]
      });
      
      if (!organization) {
        throw new ValidationError('Organization not found');
      }
      
      // Get full hierarchy path
      const hierarchyPath = await organization.getFullHierarchy();
      
      return {
        organization,
        hierarchyPath,
        subOrganizations: organization.SubOrganizations || []
      };
      
    } catch (error) {
      logger.error({ error, organizationId, userId }, 'Error getting organization hierarchy');
      throw error;
    }
  }
  
  // Permission helper methods
  
  async userHasOrganizationAccess(userId, organizationId) {
    try {
      const user = await User.findByPk(userId);
      if (!user) return false;
      
      // Super admins have access to all organizations
      if (user.isSuperAdmin()) return true;
      
      // Check membership
      const membership = await OrganizationUser.findOne({
        where: {
          userId,
          organizationId,
          isActive: true
        }
      });
      
      return !!membership;
    } catch (error) {
      logger.error({ error, userId, organizationId }, 'Error checking user organization access');
      return false;
    }
  }
  
  async userCanManageOrganization(userId, organizationId, transaction = null) {
    try {
      const user = await User.findByPk(userId, { transaction });
      if (!user) return false;
      
      // Super admins can manage all organizations
      if (user.isSuperAdmin()) return true;
      
      // Check if user is owner or admin
      const membership = await OrganizationUser.findOne({
        where: {
          userId,
          organizationId,
          role: { [Op.in]: ['owner', 'admin'] },
          isActive: true
        },
        transaction
      });
      
      return !!membership;
    } catch (error) {
      logger.error({ error, userId, organizationId }, 'Error checking user organization management permissions');
      return false;
    }
  }
  
  async userCanInviteToOrganization(userId, organizationId, transaction = null) {
    try {
      const user = await User.findByPk(userId, { transaction });
      if (!user) return false;
      
      // Super admins can invite to all organizations
      if (user.isSuperAdmin()) return true;
      
      // Check if user has invite permissions
      const membership = await OrganizationUser.findOne({
        where: {
          userId,
          organizationId,
          role: { [Op.in]: ['owner', 'admin', 'manager'] },
          isActive: true
        },
        transaction
      });
      
      return !!membership;
    } catch (error) {
      logger.error({ error, userId, organizationId }, 'Error checking user invite permissions');
      return false;
    }
  }
  
  async userCanManageMembers(userId, organizationId, transaction = null) {
    try {
      const user = await User.findByPk(userId, { transaction });
      if (!user) return false;
      
      // Super admins can manage members in all organizations
      if (user.isSuperAdmin()) return true;
      
      // Check if user has member management permissions
      const membership = await OrganizationUser.findOne({
        where: {
          userId,
          organizationId,
          role: { [Op.in]: ['owner', 'admin', 'manager'] },
          isActive: true
        },
        transaction
      });
      
      return !!membership;
    } catch (error) {
      logger.error({ error, userId, organizationId }, 'Error checking user member management permissions');
      return false;
    }
  }
}

export const organizationService = new OrganizationService();
