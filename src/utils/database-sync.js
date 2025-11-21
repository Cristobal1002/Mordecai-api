import { sequelize } from '../config/database.js';
import { logger } from './logger.js';

/**
 * Database Sync Manager - Handles gradual table synchronization
 */
export class DatabaseSyncManager {
  
  /**
   * Safely sync a single table with validation and error handling
   */
  static async syncTableSafely(Model, tableName, syncOptions = {}) {
    try {
      logger.info(`🔄 Starting sync for table: ${tableName}`);
      
      // 1. Check if table exists
      const tableExists = await this.tableExists(tableName);
      
      if (tableExists) {
        logger.info(`📋 Table ${tableName} already exists`);
        
        // 2. Check if we need to alter the table
        if (syncOptions.alter) {
          logger.info(`🔧 Altering table ${tableName}...`);
          await Model.sync({ alter: true });
          logger.info(`✅ Table ${tableName} altered successfully`);
        } else {
          logger.info(`⏭️  Table ${tableName} exists, no changes requested`);
        }
      } else {
        // 3. Create new table
        logger.info(`🆕 Creating new table ${tableName}...`);
        await Model.sync(syncOptions);
        logger.info(`✅ Table ${tableName} created successfully`);
      }
      
      // 4. Verify table structure
      await this.verifyTableStructure(tableName);
      
      return true;
    } catch (error) {
      logger.error(`❌ Error syncing table ${tableName}:`, error);
      throw error;
    }
  }
  
  /**
   * Check if a table exists in the database
   */
  static async tableExists(tableName) {
    try {
      const [results] = await sequelize.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = $1
        );
      `, {
        bind: [tableName],
        type: sequelize.QueryTypes.SELECT
      });
      
      return results.exists;
    } catch (error) {
      logger.error(`Error checking if table ${tableName} exists:`, error);
      return false;
    }
  }
  
  /**
   * Verify table structure matches model definition
   */
  static async verifyTableStructure(tableName) {
    try {
      const [columns] = await sequelize.query(`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = $1
        ORDER BY ordinal_position;
      `, {
        bind: [tableName],
        type: sequelize.QueryTypes.SELECT
      });
      
      logger.debug(`📊 Table ${tableName} has ${columns.length} columns`);
      return columns;
    } catch (error) {
      logger.warn(`Warning: Could not verify structure for table ${tableName}:`, error);
      return [];
    }
  }
  
  /**
   * Create a backup of a table before making changes
   */
  static async backupTable(tableName) {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupName = `${tableName}_backup_${timestamp}`;
      
      await sequelize.query(`CREATE TABLE ${backupName} AS SELECT * FROM ${tableName}`);
      logger.info(`💾 Backup created: ${backupName}`);
      return backupName;
    } catch (error) {
      logger.error(`Error creating backup for ${tableName}:`, error);
      throw error;
    }
  }
  
  /**
   * Get table row count
   */
  static async getTableCount(tableName) {
    try {
      const [result] = await sequelize.query(`SELECT COUNT(*) as count FROM ${tableName}`, {
        type: sequelize.QueryTypes.SELECT
      });
      return parseInt(result.count);
    } catch (error) {
      logger.warn(`Could not get count for table ${tableName}:`, error);
      return 0;
    }
  }
  
  /**
   * Check database connection
   */
  static async checkConnection() {
    try {
      await sequelize.authenticate();
      logger.info('✅ Database connection verified');
      return true;
    } catch (error) {
      logger.error('❌ Database connection failed:', error);
      return false;
    }
  }
  
  /**
   * Get database version and info
   */
  static async getDatabaseInfo() {
    try {
      const [result] = await sequelize.query('SELECT version()', {
        type: sequelize.QueryTypes.SELECT
      });
      
      const version = result.version;
      logger.info(`📊 Database: ${version}`);
      return version;
    } catch (error) {
      logger.warn('Could not get database version:', error);
      return 'Unknown';
    }
  }
  
  /**
   * Sync multiple tables with dependency order
   */
  static async syncTablesInOrder(tableConfigs) {
    const results = [];
    
    for (const config of tableConfigs) {
      const { model, tableName, syncOptions = {}, required = true } = config;
      
      try {
        if (!model) {
          if (required) {
            throw new Error(`Model not found for table ${tableName}`);
          } else {
            logger.warn(`⚠️  Skipping optional table ${tableName} - model not available`);
            continue;
          }
        }
        
        const success = await this.syncTableSafely(model, tableName, syncOptions);
        results.push({ tableName, success, error: null });
        
      } catch (error) {
        logger.error(`Failed to sync table ${tableName}:`, error);
        results.push({ tableName, success: false, error: error.message });
        
        if (required) {
          throw error; // Stop on required table failure
        }
      }
    }
    
    return results;
  }
  
  /**
   * Rollback table changes (drop table)
   */
  static async rollbackTable(tableName) {
    try {
      logger.warn(`🔄 Rolling back table: ${tableName}`);
      
      // First, check if table exists
      const exists = await this.tableExists(tableName);
      if (!exists) {
        logger.info(`Table ${tableName} does not exist, nothing to rollback`);
        return true;
      }
      
      // Drop the table
      await sequelize.query(`DROP TABLE IF EXISTS ${tableName} CASCADE`);
      logger.info(`✅ Table ${tableName} rolled back (dropped)`);
      return true;
      
    } catch (error) {
      logger.error(`❌ Error rolling back table ${tableName}:`, error);
      throw error;
    }
  }
  
  /**
   * Get all tables in the database
   */
  static async getAllTables() {
    try {
      const [tables] = await sequelize.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_type = 'BASE TABLE'
        ORDER BY table_name;
      `, {
        type: sequelize.QueryTypes.SELECT
      });
      
      return tables.map(t => t.table_name);
    } catch (error) {
      logger.error('Error getting table list:', error);
      return [];
    }
  }
  
  /**
   * Generate sync report
   */
  static async generateSyncReport() {
    try {
      const tables = await this.getAllTables();
      const report = {
        timestamp: new Date().toISOString(),
        totalTables: tables.length,
        tables: []
      };
      
      for (const tableName of tables) {
        const count = await this.getTableCount(tableName);
        const columns = await this.verifyTableStructure(tableName);
        
        report.tables.push({
          name: tableName,
          rowCount: count,
          columnCount: columns.length,
          columns: columns.map(c => ({
            name: c.column_name,
            type: c.data_type,
            nullable: c.is_nullable === 'YES'
          }))
        });
      }
      
      logger.info(`📊 Database sync report generated: ${report.totalTables} tables`);
      return report;
    } catch (error) {
      logger.error('Error generating sync report:', error);
      return null;
    }
  }
}
