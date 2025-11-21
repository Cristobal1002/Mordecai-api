import { sequelize } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';
import { initModels } from '../models/index.js';
import { DatabaseSyncManager } from '../utils/database-sync.js';

export const loadDatabase = async () => {
  try {
    logger.info('Connecting to PostgreSQL...');
    await sequelize.authenticate();
    logger.info('Database connected');

    // Inicializa modelos
    initModels(sequelize);
    logger.info('Models initialized');

    // Gradual model synchronization with multi-tenant support
    if (config.db.sync.mode) {
      logger.info('🚀 Starting gradual model synchronization...');
      
      const syncOptions = {};
      
      if (config.db.sync.mode === 'alter') {
        syncOptions.alter = true;
        logger.warn('⚠️  Using alter mode - will modify existing tables');
      } else if (config.db.sync.mode === 'force') {
        syncOptions.force = true;
        logger.error('🚨 Using force mode - will delete all tables');
        if (config.app.nodeEnv === 'production') {
          throw new Error('Don\'t allow sync with force=true in production');
        }
      }
      
      // Sync tables gradually with dependency order
      await syncModelsGradually(syncOptions);
      logger.info('✅ All models synchronized with the database');
    } else {
      logger.info('⏭️  Sync disabled (use migrations for database changes)');
    }
  } catch (error) {
    logger.error({ error }, 'Error loading the database');
    throw error;
  }
};

/**
 * Sync models gradually with proper dependency order and feature flags
 */
async function syncModelsGradually(syncOptions) {
  try {
    // Get models from the initialized models
    const models = sequelize.models;
    
    // Verify database connection first
    await DatabaseSyncManager.checkConnection();
    await DatabaseSyncManager.getDatabaseInfo();
    
    // Define sync configuration with dependency order
    const tableConfigs = [
      // 1. CORE TABLE: Users (always sync - required for Firebase auth)
      {
        model: models.User,
        tableName: 'users',
        syncOptions: { ...syncOptions },
        required: true,
        enabled: config.dbSync.users,
        description: 'Core users table (Firebase authenticated users)'
      },
      
      // 2. ORGANIZATIONS TABLE: Only if multi-tenant is enabled
      {
        model: models.Organization,
        tableName: 'organizations',
        syncOptions: { ...syncOptions, force: false }, // Never force on new tables
        required: false,
        enabled: config.features.multiTenant && config.dbSync.organizations,
        description: 'Organizations table (multi-tenant support)'
      },
      
      // 3. ORGANIZATION-USERS TABLE: Only if multi-tenant is enabled (depends on users + organizations)
      {
        model: models.OrganizationUser,
        tableName: 'organization_users',
        syncOptions: { ...syncOptions, force: false }, // Never force on new tables
        required: false,
        enabled: config.features.multiTenant && config.dbSync.organizationUsers,
        description: 'Organization memberships table (many-to-many users <-> organizations)'
      }
    ];
    
    // Filter enabled tables
    const enabledTables = tableConfigs.filter(config => config.enabled);
    
    logger.info(`📊 Syncing ${enabledTables.length} tables (${tableConfigs.length - enabledTables.length} disabled)`);
    
    // Log sync plan
    enabledTables.forEach(config => {
      logger.info(`  📋 ${config.tableName}: ${config.description}`);
    });
    
    // Sync tables in dependency order
    const results = await DatabaseSyncManager.syncTablesInOrder(enabledTables);
    
    // Log results
    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    
    logger.info(`📊 Sync completed: ${successful} successful, ${failed} failed`);
    
    if (failed > 0) {
      const failedTables = results.filter(r => !r.success).map(r => r.tableName);
      logger.error(`❌ Failed tables: ${failedTables.join(', ')}`);
    }
    
    // Setup associations after all tables are created
    if (successful > 0) {
      await setupModelAssociations();
    }
    
    // Generate sync report in development
    if (config.app.nodeEnv === 'development') {
      const report = await DatabaseSyncManager.generateSyncReport();
      if (report) {
        logger.debug('📊 Database sync report:', report);
      }
    }
    
  } catch (error) {
    logger.error('💥 Error in gradual model synchronization:', error);
    throw error;
  }
}

/**
 * Setup model associations after tables are created
 */
async function setupModelAssociations() {
  try {
    logger.info('🔗 Setting up model associations...');
    
    const models = sequelize.models;
    
    // Only setup associations if models exist
    if (models.User && models.Organization && models.OrganizationUser) {
      
      // User belongs to organizations through OrganizationUser
      models.User.belongsToMany(models.Organization, {
        through: models.OrganizationUser,
        foreignKey: 'userId',
        otherKey: 'organizationId',
        as: 'Organizations'
      });
      
      // Organization has many users through OrganizationUser
      models.Organization.belongsToMany(models.User, {
        through: models.OrganizationUser,
        foreignKey: 'organizationId',
        otherKey: 'userId',
        as: 'Members'
      });
      
      // OrganizationUser belongs to User
      models.OrganizationUser.belongsTo(models.User, {
        foreignKey: 'userId',
        as: 'User'
      });
      
      // OrganizationUser belongs to Organization
      models.OrganizationUser.belongsTo(models.Organization, {
        foreignKey: 'organizationId',
        as: 'Organization'
      });
      
      // Organization hierarchy (self-referencing)
      models.Organization.hasMany(models.Organization, {
        as: 'SubOrganizations',
        foreignKey: 'parentId'
      });
      
      models.Organization.belongsTo(models.Organization, {
        as: 'ParentOrganization',
        foreignKey: 'parentId'
      });
      
      // OrganizationUser invited by User
      models.OrganizationUser.belongsTo(models.User, {
        foreignKey: 'invitedBy',
        as: 'InvitedByUser'
      });
      
      logger.info('✅ Model associations established');
    } else {
      logger.info('⏭️  Skipping associations - not all models available');
    }
    
  } catch (error) {
    logger.warn('⚠️  Warning: Could not setup all model associations:', error);
    // Don't throw - associations are not critical for basic functionality
  }
}

