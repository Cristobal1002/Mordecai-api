import { sequelize } from '../config/database.js';
import { defineUserModel } from './user.model.js';
import { defineOrganizationModel } from './organization.model.js';
import { defineOrganizationUserModel } from './organization-user.model.js';
import { config } from '../config/index.js';

// Initialize core models (always available)
export const User = defineUserModel(sequelize);

// Initialize multi-tenant models (only if feature is enabled)
let Organization = null;
let OrganizationUser = null;

if (config.features.multiTenant) {
  Organization = defineOrganizationModel(sequelize);
  OrganizationUser = defineOrganizationUserModel(sequelize);
}

export { Organization, OrganizationUser, sequelize };

/**
 * Inicializa todos los modelos de Sequelize y sus relaciones
 * @param {Sequelize} sequelize - Instancia de Sequelize
 */
export const initModels = (sequelize) => {
  // Models are initialized above based on feature flags
  
  // Core User model (always available):
  // - firebaseUid (primary identifier from Firebase Auth)
  // - displayName (cached locally for performance)
  // - systemRole (global system permissions: super_admin, system_admin, user)
  // - isActive, lastLoginAt, loginAttempts, etc. (security fields)
  // Firebase handles: email, authentication, profile picture, email verification
  // Organization roles are managed through OrganizationUser model
  
  // Multi-tenant models (when ENABLE_MULTI_TENANT=true):
  // - Organization: company/tenant data with hierarchy support
  // - OrganizationUser: user memberships with roles and permissions per organization
  
  // The models will be registered with Sequelize during the sync process
  // Associations are setup after table creation in the database loader
};

