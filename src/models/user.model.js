import { DataTypes, Op } from 'sequelize';
import { config } from '../config/index.js';

export const defineUserModel = (sequelize) => {
  const User = sequelize.define(
    'User',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      // Firebase UID is the main identifier - Firebase handles email, name, etc.
      firebaseUid: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
        comment: 'Firebase user UID - primary identifier',
      },
      // User display name (stored locally for performance)
      displayName: {
        type: DataTypes.STRING,
        allowNull: true,
        validate: {
          len: [1, 255],
        },
        comment: 'User display name - stored locally for better performance',
      },
      // System-wide role (for super admins and system management)
      systemRole: {
        type: DataTypes.ENUM('super_admin', 'system_admin', 'user'),
        allowNull: false,
        defaultValue: 'user',
        comment: 'Global system role - independent of organizations',
      },
      
      // Legacy app role (kept for backward compatibility)
      appRole: {
        type: DataTypes.ENUM('user', 'admin', 'moderator', 'manager', 'editor'),
        allowNull: true, // Made optional for multi-tenant
        defaultValue: 'user',
        comment: 'Legacy application role - use organization roles instead',
      },
      isActive: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
        comment: 'Account status - can be deactivated',
      },
      // Optional: Remove if you don't need user preferences
      // preferences: {
      //   type: DataTypes.JSONB, // PostgreSQL JSON field
      //   allowNull: true,
      //   defaultValue: {},
      //   comment: 'User preferences and settings (theme, notifications, etc.)',
      // },
      // Security tracking (minimal)
      lastLoginAt: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: 'Last successful login timestamp',
      },
      loginAttempts: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: 'Failed login attempts counter',
      },
      lockedUntil: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: 'Account lock expiration time',
      },
    },
    {
      tableName: 'users',
      timestamps: true,
      paranoid: true, // Enable soft delete
      indexes: [
        {
          unique: true,
          fields: ['firebaseUid'],
          name: 'users_firebase_uid_unique',
          where: {
            deletedAt: null // Unique constraint only for non-deleted records
          }
        },
        {
          fields: ['appRole'],
          name: 'users_app_role_index',
        },
        {
          fields: ['isActive'],
          name: 'users_is_active_index',
        },
        {
          fields: ['lastLoginAt'],
          name: 'users_last_login_index',
        },
        {
          fields: ['deletedAt'],
          name: 'users_deleted_at_index',
        },
      ],
    }
  );

  // Instance methods for security
  User.prototype.isLocked = function () {
    return !!(this.lockedUntil && this.lockedUntil > Date.now());
  };

  User.prototype.incLoginAttempts = async function () {
    // If we have a previous lock that has expired, restart at 1
    if (this.lockedUntil && this.lockedUntil < Date.now()) {
      return this.update({
        loginAttempts: 1,
        lockedUntil: null,
      });
    }

    const updates = { loginAttempts: this.loginAttempts + 1 };

    // Lock the account if we've reached max attempts and it's not locked already
    if (this.loginAttempts + 1 >= config.auth.maxLoginAttempts && !this.isLocked()) {
      updates.lockedUntil = Date.now() + config.auth.lockoutTime;
    }

    return this.update(updates);
  };

  User.prototype.resetLoginAttempts = async function () {
    return this.update({
      loginAttempts: 0,
      lockedUntil: null,
    });
  };

  // Remove preferences method if not using preferences
  // User.prototype.updatePreferences = async function (newPreferences) {
  //   const currentPreferences = this.preferences || {};
  //   const updatedPreferences = { ...currentPreferences, ...newPreferences };
  //   return this.update({ preferences: updatedPreferences });
  // };

  User.prototype.toJSON = function () {
    const values = { ...this.get() };
    // Remove sensitive security fields from JSON output
    delete values.loginAttempts;
    delete values.lockedUntil;
    return values;
  };

  // Soft delete methods
  User.prototype.softDelete = async function () {
    return this.destroy(); // Uses soft delete due to paranoid: true
  };

  User.prototype.restore = async function () {
    return this.restore();
  };

  User.prototype.isDeleted = function () {
    return this.deletedAt !== null;
  };

  // Static methods for querying deleted records
  User.findWithDeleted = function (options = {}) {
    return User.findAll({ ...options, paranoid: false });
  };

  User.findOnlyDeleted = function (options = {}) {
    return User.findAll({ 
      ...options, 
      paranoid: false,
      where: {
        ...options.where,
        deletedAt: { [Op.ne]: null }
      }
    });
  };

  User.countWithDeleted = function (options = {}) {
    return User.count({ ...options, paranoid: false });
  };

  User.countOnlyDeleted = function (options = {}) {
    return User.count({ 
      ...options, 
      paranoid: false,
      where: {
        ...options.where,
        deletedAt: { [Op.ne]: null }
      }
    });
  };

  // Multi-tenant instance methods
  User.prototype.isSuperAdmin = function() {
    return this.systemRole === 'super_admin';
  };

  User.prototype.isSystemAdmin = function() {
    return ['super_admin', 'system_admin'].includes(this.systemRole);
  };

  User.prototype.getOrganizations = async function(includeInactive = false) {
    const OrganizationUser = sequelize.models.OrganizationUser;
    if (!OrganizationUser) return [];
    
    const where = { userId: this.id };
    if (!includeInactive) {
      where.isActive = true;
    }
    
    return await OrganizationUser.findAll({
      where,
      include: [{
        model: sequelize.models.Organization,
        as: 'Organization',
        where: { isActive: true },
      }],
      order: [['joinedAt', 'DESC']],
    });
  };

  User.prototype.getOrganizationRole = async function(organizationId) {
    const OrganizationUser = sequelize.models.OrganizationUser;
    if (!OrganizationUser) return null;
    
    const membership = await OrganizationUser.findOne({
      where: {
        userId: this.id,
        organizationId,
        isActive: true,
      },
    });
    
    return membership ? membership.role : null;
  };

  User.prototype.hasOrganizationAccess = async function(organizationId) {
    // Super admins have access to all organizations
    if (this.isSuperAdmin()) {
      return true;
    }
    
    const OrganizationUser = sequelize.models.OrganizationUser;
    if (!OrganizationUser) return false;
    
    const membership = await OrganizationUser.findOne({
      where: {
        userId: this.id,
        organizationId,
        isActive: true,
      },
    });
    
    return !!membership;
  };

  User.prototype.canManageOrganization = async function(organizationId) {
    // Super admins can manage all organizations
    if (this.isSuperAdmin()) {
      return true;
    }
    
    const OrganizationUser = sequelize.models.OrganizationUser;
    if (!OrganizationUser) return false;
    
    const membership = await OrganizationUser.findOne({
      where: {
        userId: this.id,
        organizationId,
        isActive: true,
      },
    });
    
    return membership && ['owner', 'admin'].includes(membership.role);
  };

  // Multi-tenant static methods
  User.findByFirebaseUid = function(firebaseUid) {
    return this.findOne({
      where: { firebaseUid, isActive: true },
    });
  };

  User.findSuperAdmins = function() {
    return this.findAll({
      where: { 
        systemRole: 'super_admin',
        isActive: true 
      },
    });
  };

  return User;
};
