import { Router } from 'express';
import { userController } from '../controllers/user.controller.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import { validateRequest } from '../middlewares/validate-request.middleware.js';
import { body, param, query } from 'express-validator';

const router = Router();

// Validation schemas
// Remove preferences validation if not using preferences
// const updatePreferencesValidation = [
//   body('*').optional(),
// ];

const updateSystemRoleValidation = [
  param('firebaseUid').notEmpty().withMessage('Firebase UID is required'),
  body('systemRole').isIn(['super_admin', 'system_admin', 'user']).withMessage('Invalid system role'),
];

const userParamValidation = [
  param('firebaseUid').notEmpty().withMessage('Firebase UID is required'),
];

const usersListValidation = [
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100'),
  query('systemRole').optional().isIn(['super_admin', 'system_admin', 'user']).withMessage('Invalid system role'),
  query('isActive').optional().isBoolean().withMessage('isActive must be a boolean'),
  query('search').optional().isLength({ min: 1, max: 100 }).withMessage('Search term must be between 1 and 100 characters'),
  query('sortBy').optional().isIn(['createdAt', 'updatedAt', 'lastLoginAt', 'systemRole']).withMessage('Invalid sort field'),
  query('sortOrder').optional().isIn(['ASC', 'DESC', 'asc', 'desc']).withMessage('Sort order must be ASC or DESC'),
  query('includeDeleted').optional().isBoolean().withMessage('includeDeleted must be a boolean'),
  query('dateFrom').optional().isISO8601().withMessage('dateFrom must be a valid ISO date'),
  query('dateTo').optional().isISO8601().withMessage('dateTo must be a valid ISO date'),
];

const userOrganizationsValidation = [
  param('firebaseUid').notEmpty().withMessage('Firebase UID is required'),
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100'),
  query('includeInactive').optional().isBoolean().withMessage('includeInactive must be a boolean'),
  query('role').optional().isIn(['owner', 'admin', 'manager', 'employee', 'viewer', 'guest']).withMessage('Invalid role filter'),
  query('search').optional().isLength({ min: 1, max: 100 }).withMessage('Search term must be between 1 and 100 characters'),
  query('sortBy').optional().isIn(['joinedAt', 'name', 'createdAt', 'role']).withMessage('Invalid sort field'),
  query('sortOrder').optional().isIn(['ASC', 'DESC', 'asc', 'desc']).withMessage('Sort order must be ASC or DESC'),
];

/**
 * @route   GET /api/v1/users/profile
 * @desc    Get current user profile (with Firebase data)
 * @access  Private
 */
router.get('/profile', authenticate, userController.getProfile);

// Remove preferences route if not using preferences
// /**
//  * @route   PUT /api/v1/users/preferences
//  * @desc    Update user preferences
//  * @access  Private
//  */
// router.put('/preferences', authenticate, updatePreferencesValidation, validateRequest, userController.updatePreferences);

/**
 * @route   GET /api/v1/users
 * @desc    Get users list with advanced filtering and search (system admin only)
 * @access  Private (System Admin)
 * @query   page, limit, systemRole, isActive, search, sortBy, sortOrder, includeDeleted, dateFrom, dateTo
 */
router.get('/', authenticate, usersListValidation, validateRequest, userController.getUsersList);

/**
 * @route   GET /api/v1/users/overview
 * @desc    Get users overview/dashboard summary (system admin only)
 * @access  Private (System Admin)
 */
router.get('/overview', authenticate, userController.getUsersOverview);

/**
 * @route   PUT /api/v1/users/:firebaseUid/system-role
 * @desc    Update user system role (super admin only)
 * @access  Private (Super Admin)
 */
router.put('/:firebaseUid/system-role', authenticate, updateSystemRoleValidation, validateRequest, userController.updateUserSystemRole);

/**
 * @route   PUT /api/v1/users/:firebaseUid/deactivate
 * @desc    Deactivate user account (system admin only)
 * @access  Private (System Admin)
 */
router.put('/:firebaseUid/deactivate', authenticate, userParamValidation, validateRequest, userController.deactivateUser);

/**
 * @route   DELETE /api/v1/users/:firebaseUid
 * @desc    Soft delete user (super admin only)
 * @access  Private (Super Admin)
 */
router.delete('/:firebaseUid', authenticate, userParamValidation, validateRequest, userController.deleteUser);

/**
 * @route   DELETE /api/v1/users/:firebaseUid/permanent
 * @desc    Permanently delete user (super admin only)
 * @access  Private (Super Admin)
 */
router.delete('/:firebaseUid/permanent', authenticate, userParamValidation, validateRequest, userController.permanentlyDeleteUser);

/**
 * @route   POST /api/v1/users/:firebaseUid/restore
 * @desc    Restore soft deleted user (super admin only)
 * @access  Private (Super Admin)
 */
router.post('/:firebaseUid/restore', authenticate, userParamValidation, validateRequest, userController.restoreUser);

/**
 * @route   GET /api/v1/users/deleted
 * @desc    Get deleted users list (super admin only)
 * @access  Private (Super Admin)
 */
router.get('/deleted', authenticate, usersListValidation, validateRequest, userController.getDeletedUsers);

/**
 * @route   GET /api/v1/users/stats
 * @desc    Get user statistics (system admin only)
 * @access  Private (System Admin)
 */
router.get('/stats', authenticate, userController.getUserStats);

/**
 * @route   GET /api/v1/users/:firebaseUid/organizations
 * @desc    Get organizations for a specific user (own user or super admin)
 * @access  Private (Own user or Super Admin)
 * @query   page, limit, includeInactive, role, search, sortBy, sortOrder
 */
router.get('/:firebaseUid/organizations', 
  authenticate, 
  userOrganizationsValidation, 
  validateRequest, 
  userController.getUserOrganizations
);

export { router as user };
