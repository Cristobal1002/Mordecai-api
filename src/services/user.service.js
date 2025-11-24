import { Op } from 'sequelize';
import { sequelize } from '../models/index.js';
import { getAuth } from '../config/firebase.js';
import { User, Organization, OrganizationUser } from '../models/index.js';
import { AuthenticationError, ValidationError } from '../errors/index.js';
import { logger } from '../utils/logger.js';

class UserService {
  /**
   * Get complete user profile combining PostgreSQL and Firebase data
   */
  async getUserProfile(firebaseUid) {
    try {
      // Get app-specific data from PostgreSQL
      const appUser = await User.findOne({ 
        where: { firebaseUid } 
      });

      if (!appUser) {
        throw new AuthenticationError('User not found in application database');
      }

      // Get profile data from Firebase
      const firebaseUser = await getAuth().getUser(firebaseUid);

      // Combine data for complete profile
      return {
        // App-specific data from PostgreSQL
        id: appUser.id,
        firebaseUid: appUser.firebaseUid,
        systemRole: appUser.systemRole,
        displayName: appUser.displayName,
        isActive: appUser.isActive,
        lastLoginAt: appUser.lastLoginAt,
        createdAt: appUser.createdAt,
        updatedAt: appUser.updatedAt,
        
        // Profile data from Firebase
        email: firebaseUser.email,
        photoURL: firebaseUser.photoURL,
        emailVerified: firebaseUser.emailVerified,
        providerData: firebaseUser.providerData,
        metadata: {
          creationTime: firebaseUser.metadata.creationTime,
          lastSignInTime: firebaseUser.metadata.lastSignInTime,
        },
      };
    } catch (error) {
      logger.error({ error, firebaseUid }, 'Error getting user profile');
      throw error;
    }
  }

  /**
   * Create minimal user record in PostgreSQL
   */
  async createAppUser(firebaseUid, options = {}) {
    try {
      const user = await User.create({
        firebaseUid,
        systemRole: options.systemRole || 'user',
        displayName: options.displayName,
        isActive: options.isActive !== undefined ? options.isActive : true,
        lastLoginAt: new Date(),
      });

      logger.info({ userId: user.id, firebaseUid }, 'App user created');
      return user;
    } catch (error) {
      logger.error({ error, firebaseUid }, 'Error creating app user');
      throw error;
    }
  }

  // Remove preferences method if not using preferences
  // /**
  //  * Update user preferences
  //  */
  // async updateUserPreferences(firebaseUid, preferences) {
  //   try {
  //     const user = await User.findOne({ where: { firebaseUid } });
      
  //     if (!user) {
  //       throw new AuthenticationError('User not found');
  //     }

  //     await user.updatePreferences(preferences);
      
  //     logger.info({ userId: user.id, preferences }, 'User preferences updated');
  //     return user;
  //   } catch (error) {
  //     logger.error({ error, firebaseUid }, 'Error updating user preferences');
  //     throw error;
  //   }
  // }

  /**
   * Update user system role (super admin function)
   */
  async updateUserSystemRole(firebaseUid, newSystemRole, adminFirebaseUid) {
    try {
      // Verify super admin permissions
      const admin = await User.findOne({ where: { firebaseUid: adminFirebaseUid } });
      if (!admin || !admin.isSuperAdmin()) {
        throw new AuthenticationError('Insufficient permissions - super admin required');
      }

      const user = await User.findOne({ where: { firebaseUid } });
      if (!user) {
        throw new AuthenticationError('User not found');
      }

      // Validate systemRole value
      const validRoles = ['super_admin', 'system_admin', 'user'];
      if (!validRoles.includes(newSystemRole)) {
        throw new ValidationError('Invalid system role');
      }

      await user.update({ systemRole: newSystemRole });
      
      logger.info(
        { userId: user.id, newSystemRole, adminId: admin.id }, 
        'User system role updated'
      );
      
      return user;
    } catch (error) {
      logger.error({ error, firebaseUid, newSystemRole }, 'Error updating user system role');
      throw error;
    }
  }

  /**
   * Deactivate user account (system admin function)
   */
  async deactivateUser(firebaseUid, adminFirebaseUid) {
    try {
      // Verify system admin permissions
      const admin = await User.findOne({ where: { firebaseUid: adminFirebaseUid } });
      if (!admin || !admin.isSystemAdmin()) {
        throw new AuthenticationError('Insufficient permissions - system admin required');
      }

      const user = await User.findOne({ where: { firebaseUid } });
      if (!user) {
        throw new AuthenticationError('User not found');
      }

      // Prevent deactivating super admins (unless done by another super admin)
      if (user.isSuperAdmin() && !admin.isSuperAdmin()) {
        throw new AuthenticationError('Cannot deactivate super admin without super admin privileges');
      }

      // Deactivate in PostgreSQL
      await user.update({ isActive: false });

      // Disable in Firebase
      await getAuth().updateUser(firebaseUid, { disabled: true });
      
      logger.info(
        { userId: user.id, adminId: admin.id }, 
        'User account deactivated'
      );
      
      return user;
    } catch (error) {
      logger.error({ error, firebaseUid }, 'Error deactivating user');
      throw error;
    }
  }

  /**
   * Get users list with advanced filtering and search (system admin function)
   */
  async getUsersList(adminFirebaseUid, options = {}) {
    try {
      // Verify system admin permissions
      const admin = await User.findOne({ where: { firebaseUid: adminFirebaseUid } });
      if (!admin || !admin.isSystemAdmin()) {
        throw new AuthenticationError('Insufficient permissions - system admin required');
      }

      const { 
        page = 1, 
        limit = 20, 
        systemRole, 
        isActive, 
        search,
        sortBy = 'createdAt',
        sortOrder = 'DESC',
        includeDeleted = false,
        dateFrom,
        dateTo
      } = options;

      const offset = (page - 1) * limit;
      const whereClause = {};
      
      // Build where clause for filters
      if (systemRole) whereClause.systemRole = systemRole;
      if (isActive !== undefined) whereClause.isActive = isActive;
      
      // Date range filter
      if (dateFrom || dateTo) {
        whereClause.createdAt = {};
        if (dateFrom) whereClause.createdAt[Op.gte] = new Date(dateFrom);
        if (dateTo) whereClause.createdAt[Op.lte] = new Date(dateTo);
      }

      // Search functionality (will search in Firebase data later)
      const searchTerm = search ? search.toLowerCase().trim() : null;

      // Validate sort options
      const validSortFields = ['createdAt', 'updatedAt', 'lastLoginAt', 'systemRole'];
      const validSortOrders = ['ASC', 'DESC'];
      
      const finalSortBy = validSortFields.includes(sortBy) ? sortBy : 'createdAt';
      const finalSortOrder = validSortOrders.includes(sortOrder.toUpperCase()) ? sortOrder.toUpperCase() : 'DESC';

      const queryOptions = {
        where: whereClause,
        limit: parseInt(limit),
        offset: parseInt(offset),
        order: [[finalSortBy, finalSortOrder]],
        paranoid: !includeDeleted, // Include soft deleted if requested
      };

      const { rows: users, count } = await User.findAndCountAll(queryOptions);

      // Get Firebase data and apply search filter
      let usersWithFirebaseData = await Promise.all(
        users.map(async (user) => {
          try {
            const firebaseUser = await getAuth().getUser(user.firebaseUid);
            return {
              ...user.toJSON(),
              email: firebaseUser.email,
              displayName: user.displayName || firebaseUser.displayName, // Prioritize PostgreSQL displayName
              emailVerified: firebaseUser.emailVerified,
              photoURL: firebaseUser.photoURL,
              disabled: firebaseUser.disabled,
              metadata: {
                creationTime: firebaseUser.metadata.creationTime,
                lastSignInTime: firebaseUser.metadata.lastSignInTime,
              },
            };
          } catch (error) {
            // If Firebase user not found, return app data only
            logger.warn({ firebaseUid: user.firebaseUid }, 'Firebase user not found');
            return {
              ...user.toJSON(),
              email: null,
              displayName: user.displayName || null, // Use PostgreSQL displayName as fallback
              emailVerified: false,
              photoURL: null,
              disabled: true,
              metadata: null,
            };
          }
        })
      );

      // Apply search filter on Firebase data
      if (searchTerm) {
        usersWithFirebaseData = usersWithFirebaseData.filter(user => {
          const searchableText = [
            user.email,
            user.displayName,
            user.systemRole,
            user.firebaseUid
          ].filter(Boolean).join(' ').toLowerCase();
          
          return searchableText.includes(searchTerm);
        });
      }

      // Recalculate pagination if search was applied
      const finalCount = searchTerm ? usersWithFirebaseData.length : count;
      const totalPages = Math.ceil(finalCount / limit);

      return {
        users: usersWithFirebaseData,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: finalCount,
          pages: totalPages,
          hasNext: page < totalPages,
          hasPrev: page > 1,
        },
        filters: {
          systemRole,
          isActive,
          search: searchTerm,
          sortBy: finalSortBy,
          sortOrder: finalSortOrder,
          includeDeleted,
          dateFrom,
          dateTo,
        },
        summary: {
          totalUsers: finalCount,
          currentPage: parseInt(page),
          resultsPerPage: usersWithFirebaseData.length,
        }
      };
    } catch (error) {
      logger.error({ error, adminFirebaseUid, options }, 'Error getting users list');
      throw error;
    }
  }

  /**
   * Get users summary/overview (optimized for dashboard)
   */
  async getUsersOverview(adminFirebaseUid) {
    try {
      // Verify system admin permissions
      const admin = await User.findOne({ where: { firebaseUid: adminFirebaseUid } });
      if (!admin || !admin.isSystemAdmin()) {
        throw new AuthenticationError('Insufficient permissions - system admin required');
      }

      // Get counts by role and status (optimized single queries)
      const [
        roleStats,
        statusStats,
        recentUsers,
        topUsers
      ] = await Promise.all([
        // Count by system role
        User.findAll({
          attributes: [
            'systemRole',
            [sequelize.fn('COUNT', sequelize.col('id')), 'count']
          ],
          group: ['systemRole'],
          raw: true
        }),
        
        // Count by status
        User.findAll({
          attributes: [
            'isActive',
            [sequelize.fn('COUNT', sequelize.col('id')), 'count']
          ],
          group: ['isActive'],
          raw: true
        }),
        
        // Recent users (last 7 days)
        User.findAll({
          where: {
            createdAt: {
              [Op.gte]: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
            }
          },
          order: [['createdAt', 'DESC']],
          limit: 10,
        }),
        
        // Most active users (by last login)
        User.findAll({
          where: {
            lastLoginAt: { [Op.ne]: null }
          },
          order: [['lastLoginAt', 'DESC']],
          limit: 10,
        })
      ]);

      // Format role statistics
      const roleDistribution = roleStats.reduce((acc, stat) => {
        acc[stat.systemRole] = parseInt(stat.count);
        return acc;
      }, {});

      // Format status statistics
      const statusDistribution = statusStats.reduce((acc, stat) => {
        acc[stat.isActive ? 'active' : 'inactive'] = parseInt(stat.count);
        return acc;
      }, {});

      return {
        overview: {
          totalUsers: Object.values(roleDistribution).reduce((sum, count) => sum + count, 0),
          activeUsers: statusDistribution.active || 0,
          inactiveUsers: statusDistribution.inactive || 0,
          recentSignups: recentUsers.length,
        },
        roleDistribution,
        statusDistribution,
        recentUsers: recentUsers.map(user => ({
          id: user.id,
          firebaseUid: user.firebaseUid,
          systemRole: user.systemRole,
          displayName: user.displayName,
          isActive: user.isActive,
          createdAt: user.createdAt,
        })),
        activeUsers: topUsers.map(user => ({
          id: user.id,
          firebaseUid: user.firebaseUid,
          systemRole: user.systemRole,
          displayName: user.displayName,
          lastLoginAt: user.lastLoginAt,
        })),
      };
    } catch (error) {
      logger.error({ error, adminFirebaseUid }, 'Error getting users overview');
      throw error;
    }
  }

  /**
   * Soft delete user (super admin function)
   */
  async deleteUser(firebaseUid, adminFirebaseUid) {
    try {
      // Verify super admin permissions
      const admin = await User.findOne({ where: { firebaseUid: adminFirebaseUid } });
      if (!admin || !admin.isSuperAdmin()) {
        throw new AuthenticationError('Insufficient permissions - super admin required');
      }

      const user = await User.findOne({ where: { firebaseUid } });
      if (!user) {
        throw new AuthenticationError('User not found');
      }

      // Disable user in Firebase (don't delete completely)
      await getAuth().updateUser(firebaseUid, { disabled: true });

      // Soft delete from PostgreSQL
      await user.softDelete();
      
      logger.info(
        { userId: user.id, adminId: admin.id }, 
        'User soft deleted'
      );
      
      return { message: 'User deleted successfully' };
    } catch (error) {
      logger.error({ error, firebaseUid }, 'Error deleting user');
      throw error;
    }
  }

  /**
   * Permanently delete user (super admin function)
   */
  async permanentlyDeleteUser(firebaseUid, adminFirebaseUid) {
    try {
      // Verify super admin permissions
      const admin = await User.findOne({ where: { firebaseUid: adminFirebaseUid } });
      if (!admin || !admin.isSuperAdmin()) {
        throw new AuthenticationError('Insufficient permissions - super admin required');
      }

      // Find user including soft deleted ones
      const user = await User.findOne({ 
        where: { firebaseUid },
        paranoid: false 
      });
      
      if (!user) {
        throw new AuthenticationError('User not found');
      }

      // Delete from Firebase completely
      await getAuth().deleteUser(firebaseUid);

      // Permanently delete from PostgreSQL
      await user.destroy({ force: true });
      
      logger.warn(
        { userId: user.id, adminId: admin.id }, 
        'User permanently deleted'
      );
      
      return { message: 'User permanently deleted' };
    } catch (error) {
      logger.error({ error, firebaseUid }, 'Error permanently deleting user');
      throw error;
    }
  }

  /**
   * Restore soft deleted user (super admin function)
   */
  async restoreUser(firebaseUid, adminFirebaseUid) {
    try {
      // Verify super admin permissions
      const admin = await User.findOne({ where: { firebaseUid: adminFirebaseUid } });
      if (!admin || !admin.isSuperAdmin()) {
        throw new AuthenticationError('Insufficient permissions - super admin required');
      }

      // Find soft deleted user
      const user = await User.findOne({ 
        where: { firebaseUid },
        paranoid: false 
      });
      
      if (!user) {
        throw new AuthenticationError('User not found');
      }

      if (!user.isDeleted()) {
        throw new ValidationError('User is not deleted');
      }

      // Re-enable user in Firebase
      await getAuth().updateUser(firebaseUid, { disabled: false });

      // Restore user in PostgreSQL
      await user.restore();
      
      logger.info(
        { userId: user.id, adminId: admin.id }, 
        'User restored'
      );
      
      return { message: 'User restored successfully', user };
    } catch (error) {
      logger.error({ error, firebaseUid }, 'Error restoring user');
      throw error;
    }
  }

  /**
   * Get user statistics (system admin function)
   */
  async getUserStats(adminFirebaseUid) {
    try {
      // Verify system admin permissions
      const admin = await User.findOne({ where: { firebaseUid: adminFirebaseUid } });
      if (!admin || !admin.isSystemAdmin()) {
        throw new AuthenticationError('Insufficient permissions - system admin required');
      }

      const [
        totalUsers,
        activeUsers,
        inactiveUsers,
        systemAdmins,
        recentUsers,
        deletedUsers,
        totalWithDeleted,
      ] = await Promise.all([
        User.count(), // Only non-deleted users
        User.count({ where: { isActive: true } }),
        User.count({ where: { isActive: false } }),
        User.count({ where: { systemRole: { [Op.in]: ['super_admin', 'system_admin'] } } }),
        User.count({
          where: {
            createdAt: {
              [Op.gte]: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // Last 30 days
            },
          },
        }),
        User.countOnlyDeleted(), // Only soft deleted users
        User.countWithDeleted(), // All users including deleted
      ]);

      return {
        totalUsers,
        activeUsers,
        inactiveUsers,
        systemAdmins,
        recentUsers,
        deletedUsers,
        totalWithDeleted,
        inactivePercentage: totalUsers > 0 ? Math.round((inactiveUsers / totalUsers) * 100) : 0,
        deletedPercentage: totalWithDeleted > 0 ? Math.round((deletedUsers / totalWithDeleted) * 100) : 0,
      };
    } catch (error) {
      logger.error({ error, adminFirebaseUid }, 'Error getting user stats');
      throw error;
    }
  }

  /**
   * Get deleted users list (super admin function)
   */
  async getDeletedUsersList(adminFirebaseUid, options = {}) {
    try {
      // Verify super admin permissions
      const admin = await User.findOne({ where: { firebaseUid: adminFirebaseUid } });
      if (!admin || !admin.isSuperAdmin()) {
        throw new AuthenticationError('Insufficient permissions - super admin required');
      }

      const { page = 1, limit = 20 } = options;
      const offset = (page - 1) * limit;

      const { rows: users, count } = await User.findAndCountAll({
        where: {},
        limit: parseInt(limit),
        offset: parseInt(offset),
        order: [['deletedAt', 'DESC']],
        paranoid: false, // Include soft deleted
        where: {
          deletedAt: { [Op.ne]: null }
        }
      });

      // Get basic Firebase data for deleted users (if still exists)
      const usersWithFirebaseData = await Promise.all(
        users.map(async (user) => {
          try {
            const firebaseUser = await getAuth().getUser(user.firebaseUid);
            return {
              ...user.toJSON(),
              email: firebaseUser.email,
              displayName: firebaseUser.displayName,
              disabled: firebaseUser.disabled,
            };
          } catch (error) {
            // Firebase user might be deleted
            return {
              ...user.toJSON(),
              email: null,
              displayName: null,
              disabled: true,
            };
          }
        })
      );

      return {
        users: usersWithFirebaseData,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: count,
          pages: Math.ceil(count / limit),
        },
      };
    } catch (error) {
      logger.error({ error, adminFirebaseUid }, 'Error getting deleted users list');
      throw error;
    }
  }

  /**
   * Get organizations for a specific user (system admin function or own user)
   */
  async getUserOrganizations(userFirebaseUid, requesterFirebaseUid, options = {}) {
    try {
      // Find the target user
      const targetUser = await User.findOne({ where: { firebaseUid: userFirebaseUid } });
      if (!targetUser) {
        throw new AuthenticationError('User not found');
      }

      // Find the requester
      const requester = await User.findOne({ where: { firebaseUid: requesterFirebaseUid } });
      if (!requester) {
        throw new AuthenticationError('Requester not found');
      }

      // Check permissions: user can see their own orgs, or system admin can see any user's orgs
      const canAccess = targetUser.firebaseUid === requester.firebaseUid || requester.isSuperAdmin();
      if (!canAccess) {
        throw new AuthenticationError('Insufficient permissions - can only view your own organizations');
      }

      const {
        page = 1,
        limit = 20,
        includeInactive = false,
        role,
        search,
        sortBy = 'joinedAt',
        sortOrder = 'DESC'
      } = options;

      const offset = (page - 1) * limit;
      
      // Build where clause
      const membershipWhere = {
        userId: targetUser.id,
      };

      if (!includeInactive) {
        membershipWhere.isActive = true;
      }

      if (role) {
        membershipWhere.role = role;
      }

      // Build organization where clause for search
      const orgWhere = { isActive: true };
      if (search) {
        orgWhere[Op.or] = [
          { name: { [Op.iLike]: `%${search}%` } },
          { slug: { [Op.iLike]: `%${search}%` } },
          { description: { [Op.iLike]: `%${search}%` } }
        ];
      }

      // Check if multi-tenant is enabled
      if (!Organization || !OrganizationUser) {
        return {
          organizations: [],
          pagination: {
            page: 1,
            limit: parseInt(limit),
            total: 0,
            pages: 0,
            hasNext: false,
            hasPrev: false,
          },
          filters: options,
          user: {
            id: targetUser.id,
            firebaseUid: targetUser.firebaseUid,
            displayName: targetUser.displayName,
            systemRole: targetUser.systemRole,
          }
        };
      }

      // Validate sort options
      const validSortFields = ['joinedAt', 'name', 'createdAt', 'role'];
      const validSortOrders = ['ASC', 'DESC'];
      const finalSortBy = validSortFields.includes(sortBy) ? sortBy : 'joinedAt';
      const finalSortOrder = validSortOrders.includes(sortOrder.toUpperCase()) ? sortOrder.toUpperCase() : 'DESC';

      // Build order clause
      let orderClause;
      if (finalSortBy === 'name') {
        // Order by organization name (nested model)
        orderClause = [[{ model: Organization, as: 'Organization' }, 'name', finalSortOrder]];
      } else if (finalSortBy === 'createdAt') {
        // Order by organization creation date (nested model)
        orderClause = [[{ model: Organization, as: 'Organization' }, 'createdAt', finalSortOrder]];
      } else {
        // Order by membership fields (joinedAt, role)
        orderClause = [[finalSortBy, finalSortOrder]];
      }

      // Get memberships with organizations
      const { rows: memberships, count } = await OrganizationUser.findAndCountAll({
        where: membershipWhere,
        include: [
          {
            model: Organization,
            as: 'Organization',
            where: orgWhere,
            include: [
              {
                model: Organization,
                as: 'ParentOrganization',
                attributes: ['id', 'name', 'slug']
              }
            ]
          }
        ],
        order: orderClause,
        limit: parseInt(limit),
        offset: parseInt(offset),
      });

      // Format response
      const organizations = memberships.map(membership => ({
        ...membership.Organization.toJSON(),
        membership: {
          id: membership.id,
          role: membership.role,
          permissions: membership.permissions,
          isActive: membership.isActive,
          joinedAt: membership.joinedAt,
          lastAccessAt: membership.lastAccessAt,
          department: membership.department,
          jobTitle: membership.jobTitle,
          invitedBy: membership.invitedBy,
          invitedAt: membership.invitedAt,
        }
      }));

      return {
        organizations,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: count,
          pages: Math.ceil(count / limit),
          hasNext: page < Math.ceil(count / limit),
          hasPrev: page > 1,
        },
        filters: {
          includeInactive,
          role,
          search,
          sortBy: finalSortBy,
          sortOrder: finalSortOrder,
        },
        user: {
          id: targetUser.id,
          firebaseUid: targetUser.firebaseUid,
          displayName: targetUser.displayName,
          systemRole: targetUser.systemRole,
        }
      };
    } catch (error) {
      logger.error({ error, userFirebaseUid, requesterFirebaseUid }, 'Error getting user organizations');
      throw error;
    }
  }
}

export const userService = new UserService();
