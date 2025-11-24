import { userService } from '../services/user.service.js';
import { logger } from '../utils/logger.js';

class UserController {
  async getProfile(req, res, next) {
    try {
      const userProfile = await userService.getUserProfile(req.firebaseUid);
      
      res.success({
        message: 'User profile retrieved successfully',
        data: {
          user: userProfile,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  // Remove preferences method if not using preferences
  // async updatePreferences(req, res, next) {
  //   try {
  //     const user = await userService.updateUserPreferences(req.firebaseUid, req.body);
      
  //     logger.info(
  //       { userId: user.id, preferences: req.body },
  //       'User preferences updated'
  //     );
      
  //     res.success({
  //       message: 'Preferences updated successfully',
  //       data: {
  //         user: user.toJSON(),
  //       },
  //     });
  //   } catch (error) {
  //     next(error);
  //   }
  // }

  async getUsersList(req, res, next) {
    try {
      const { 
        page, 
        limit, 
        systemRole, 
        isActive, 
        search,
        sortBy,
        sortOrder,
        includeDeleted,
        dateFrom,
        dateTo
      } = req.query;
      
      const result = await userService.getUsersList(req.firebaseUid, {
        page,
        limit,
        systemRole,
        isActive: isActive !== undefined ? isActive === 'true' : undefined,
        search,
        sortBy,
        sortOrder,
        includeDeleted: includeDeleted === 'true',
        dateFrom,
        dateTo,
      });
      
      res.success({
        message: 'Users list retrieved successfully',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async getUsersOverview(req, res, next) {
    try {
      const result = await userService.getUsersOverview(req.firebaseUid);
      
      res.success({
        message: 'Users overview retrieved successfully',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async updateUserSystemRole(req, res, next) {
    try {
      const { firebaseUid } = req.params;
      const { systemRole } = req.body;
      
      const user = await userService.updateUserSystemRole(firebaseUid, systemRole, req.firebaseUid);
      
      logger.info(
        { targetUserId: user.id, newSystemRole: systemRole, adminId: req.userId },
        'User system role updated by super admin'
      );
      
      res.success({
        message: 'User system role updated successfully',
        data: {
          user: user.toJSON(),
        },
      });
    } catch (error) {
      next(error);
    }
  }

  async deactivateUser(req, res, next) {
    try {
      const { firebaseUid } = req.params;
      
      const user = await userService.deactivateUser(firebaseUid, req.firebaseUid);
      
      logger.info(
        { targetUserId: user.id, adminId: req.userId },
        'User deactivated by admin'
      );
      
      res.success({
        message: 'User deactivated successfully',
        data: {
          user: user.toJSON(),
        },
      });
    } catch (error) {
      next(error);
    }
  }

  async deleteUser(req, res, next) {
    try {
      const { firebaseUid } = req.params;
      
      const result = await userService.deleteUser(firebaseUid, req.firebaseUid);
      
      logger.info(
        { targetFirebaseUid: firebaseUid, adminId: req.userId },
        'User soft deleted by admin'
      );
      
      res.success({
        message: result.message,
      });
    } catch (error) {
      next(error);
    }
  }

  async permanentlyDeleteUser(req, res, next) {
    try {
      const { firebaseUid } = req.params;
      
      const result = await userService.permanentlyDeleteUser(firebaseUid, req.firebaseUid);
      
      logger.warn(
        { targetFirebaseUid: firebaseUid, adminId: req.userId },
        'User permanently deleted by admin'
      );
      
      res.success({
        message: result.message,
      });
    } catch (error) {
      next(error);
    }
  }

  async restoreUser(req, res, next) {
    try {
      const { firebaseUid } = req.params;
      
      const result = await userService.restoreUser(firebaseUid, req.firebaseUid);
      
      logger.info(
        { targetFirebaseUid: firebaseUid, adminId: req.userId },
        'User restored by admin'
      );
      
      res.success({
        message: result.message,
        data: {
          user: result.user?.toJSON(),
        },
      });
    } catch (error) {
      next(error);
    }
  }

  async getDeletedUsers(req, res, next) {
    try {
      const { page, limit } = req.query;
      const result = await userService.getDeletedUsersList(req.firebaseUid, {
        page,
        limit,
      });
      
      res.success({
        message: 'Deleted users list retrieved successfully',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async getUserStats(req, res, next) {
    try {
      const stats = await userService.getUserStats(req.firebaseUid);
      
      res.success({
        message: 'User statistics retrieved successfully',
        data: stats,
      });
    } catch (error) {
      next(error);
    }
  }
}

export const userController = new UserController();
