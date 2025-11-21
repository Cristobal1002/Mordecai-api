import { DataTypes, Op } from 'sequelize';

export const defineOrganizationUserModel = (sequelize) => {
  const OrganizationUser = sequelize.define(
    'OrganizationUser',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      
      // Foreign keys
      userId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
          model: 'users',
          key: 'id'
        },
        comment: 'Reference to the user (Firebase authenticated)',
      },
      
      organizationId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
          model: 'organizations',
          key: 'id'
        },
        comment: 'Reference to the organization',
      },
      
      // Role within the organization
      role: {
        type: DataTypes.ENUM(
          'owner',         // Organization owner (full control)
          'admin',         // Administrator (almost full control)
          'manager',       // Manager (user management, some settings)
          'employee',      // Regular employee (basic access)
          'viewer',        // Read-only access
          'guest'          // Limited temporary access
        ),
        allowNull: false,
        defaultValue: 'employee',
        comment: 'User role within this specific organization',
      },
      
      // Granular permissions (overrides role defaults)
      permissions: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: {
          users: {
            read: false,
            write: false,
            delete: false,
            invite: false,
          },
          organizations: {
            read: false,
            write: false,
            delete: false,
            settings: false,
          },
          reports: {
            read: false,
            write: false,
            export: false,
          },
          billing: {
            read: false,
            write: false,
          },
          api: {
            read: false,
            write: false,
          }
        },
        comment: 'Granular permissions that can override role defaults',
      },
      
      // Membership status
      isActive: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
        comment: 'Membership active status',
      },
      
      // Invitation and joining info
      invitedBy: {
        type: DataTypes.UUID,
        allowNull: true,
        references: {
          model: 'users',
          key: 'id'
        },
        comment: 'User who invited this member',
      },
      
      invitedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: 'When the invitation was sent',
      },
      
      joinedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        comment: 'When the user joined the organization',
      },
      
      // Optional: Department or team within organization
      department: {
        type: DataTypes.STRING,
        allowNull: true,
        validate: {
          len: [1, 100],
        },
        comment: 'Department or team within the organization',
      },
      
      // Optional: Job title within organization
      jobTitle: {
        type: DataTypes.STRING,
        allowNull: true,
        validate: {
          len: [1, 100],
        },
        comment: 'Job title within the organization',
      },
      
      // Optional: Custom fields for organization-specific data
      customFields: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: {},
        comment: 'Organization-specific custom fields',
      },
      
      // Access control
      lastAccessAt: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: 'Last time user accessed this organization',
      },
      
      // Metadata
      metadata: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: {},
        comment: 'Additional metadata for extensibility',
      },
    },
    {
      // Table options
      tableName: 'organization_users',
      paranoid: true, // Soft delete support
      timestamps: true,
      
      // Indexes for performance
      indexes: [
        {
          unique: true,
          fields: ['userId', 'organizationId'],
          name: 'unique_user_organization',
        },
        {
          fields: ['userId'],
        },
        {
          fields: ['organizationId'],
        },
        {
          fields: ['role'],
        },
        {
          fields: ['isActive'],
        },
        {
          fields: ['joinedAt'],
        },
        {
          fields: ['lastAccessAt'],
        },
      ],
    }
  );

  // Instance methods
  OrganizationUser.prototype.hasPermission = function(resource, action) {
    const permissions = this.permissions || {};
    const resourcePerms = permissions[resource];
    
    if (!resourcePerms) {
      return false;
    }
    
    return resourcePerms[action] === true;
  };

  OrganizationUser.prototype.grantPermission = async function(resource, action) {
    const permissions = { ...this.permissions };
    
    if (!permissions[resource]) {
      permissions[resource] = {};
    }
    
    permissions[resource][action] = true;
    
    return await this.update({ permissions });
  };

  OrganizationUser.prototype.revokePermission = async function(resource, action) {
    const permissions = { ...this.permissions };
    
    if (permissions[resource]) {
      permissions[resource][action] = false;
    }
    
    return await this.update({ permissions });
  };

  OrganizationUser.prototype.updateLastAccess = async function() {
    return await this.update({ lastAccessAt: new Date() });
  };

  OrganizationUser.prototype.isOwnerOrAdmin = function() {
    return ['owner', 'admin'].includes(this.role);
  };

  OrganizationUser.prototype.canManageUsers = function() {
    return ['owner', 'admin', 'manager'].includes(this.role) || 
           this.hasPermission('users', 'write');
  };

  OrganizationUser.prototype.canManageOrganization = function() {
    return ['owner', 'admin'].includes(this.role) || 
           this.hasPermission('organizations', 'write');
  };

  // Static methods
  OrganizationUser.findByUserAndOrg = async function(userId, organizationId) {
    return await this.findOne({
      where: { 
        userId, 
        organizationId, 
        isActive: true 
      },
    });
  };

  OrganizationUser.getUserOrganizations = async function(userId, includeInactive = false) {
    const where = { userId };
    if (!includeInactive) {
      where.isActive = true;
    }
    
    return await this.findAll({
      where,
      include: [{
        model: sequelize.models.Organization,
        as: 'Organization',
        where: { isActive: true },
      }],
      order: [['joinedAt', 'DESC']],
    });
  };

  OrganizationUser.getOrganizationMembers = async function(organizationId, includeInactive = false) {
    const where = { organizationId };
    if (!includeInactive) {
      where.isActive = true;
    }
    
    return await this.findAll({
      where,
      include: [{
        model: sequelize.models.User,
        as: 'User',
        where: { isActive: true },
      }],
      order: [['joinedAt', 'ASC']],
    });
  };

  OrganizationUser.getOrgAdmins = async function(organizationId) {
    return await this.findAll({
      where: {
        organizationId,
        role: { [Op.in]: ['owner', 'admin'] },
        isActive: true,
      },
      include: [{
        model: sequelize.models.User,
        as: 'User',
        where: { isActive: true },
      }],
    });
  };

  OrganizationUser.getRolePermissions = function(role) {
    const rolePermissions = {
      owner: {
        users: { read: true, write: true, delete: true, invite: true },
        organizations: { read: true, write: true, delete: true, settings: true },
        reports: { read: true, write: true, export: true },
        billing: { read: true, write: true },
        api: { read: true, write: true },
      },
      admin: {
        users: { read: true, write: true, delete: true, invite: true },
        organizations: { read: true, write: true, delete: false, settings: true },
        reports: { read: true, write: true, export: true },
        billing: { read: true, write: false },
        api: { read: true, write: true },
      },
      manager: {
        users: { read: true, write: true, delete: false, invite: true },
        organizations: { read: true, write: false, delete: false, settings: false },
        reports: { read: true, write: true, export: true },
        billing: { read: false, write: false },
        api: { read: true, write: false },
      },
      employee: {
        users: { read: true, write: false, delete: false, invite: false },
        organizations: { read: true, write: false, delete: false, settings: false },
        reports: { read: true, write: false, export: false },
        billing: { read: false, write: false },
        api: { read: false, write: false },
      },
      viewer: {
        users: { read: true, write: false, delete: false, invite: false },
        organizations: { read: true, write: false, delete: false, settings: false },
        reports: { read: true, write: false, export: false },
        billing: { read: false, write: false },
        api: { read: false, write: false },
      },
      guest: {
        users: { read: false, write: false, delete: false, invite: false },
        organizations: { read: true, write: false, delete: false, settings: false },
        reports: { read: false, write: false, export: false },
        billing: { read: false, write: false },
        api: { read: false, write: false },
      },
    };
    
    return rolePermissions[role] || rolePermissions.guest;
  };

  // Hooks
  OrganizationUser.addHook('beforeCreate', async (orgUser) => {
    // Set default permissions based on role
    if (!orgUser.permissions || Object.keys(orgUser.permissions).length === 0) {
      orgUser.permissions = OrganizationUser.getRolePermissions(orgUser.role);
    }
  });

  OrganizationUser.addHook('beforeUpdate', async (orgUser) => {
    // Update permissions if role changed
    if (orgUser.changed('role')) {
      const rolePermissions = OrganizationUser.getRolePermissions(orgUser.role);
      
      // Merge role permissions with existing custom permissions
      const currentPermissions = orgUser.permissions || {};
      const mergedPermissions = { ...rolePermissions };
      
      // Keep any custom permissions that are more permissive
      Object.keys(currentPermissions).forEach(resource => {
        if (mergedPermissions[resource]) {
          Object.keys(currentPermissions[resource]).forEach(action => {
            if (currentPermissions[resource][action] === true) {
              mergedPermissions[resource][action] = true;
            }
          });
        }
      });
      
      orgUser.permissions = mergedPermissions;
    }
  });

  OrganizationUser.addHook('afterCreate', async (orgUser) => {
    // Log organization membership creation
    console.log(`User ${orgUser.userId} joined organization ${orgUser.organizationId} as ${orgUser.role}`);
  });

  OrganizationUser.addHook('beforeDestroy', async (orgUser) => {
    // Check if user is the last owner
    if (orgUser.role === 'owner') {
      const otherOwners = await OrganizationUser.count({
        where: {
          organizationId: orgUser.organizationId,
          role: 'owner',
          isActive: true,
          id: { [Op.ne]: orgUser.id },
        },
      });
      
      if (otherOwners === 0) {
        throw new Error('Cannot remove the last owner of an organization');
      }
    }
  });

  return OrganizationUser;
};
