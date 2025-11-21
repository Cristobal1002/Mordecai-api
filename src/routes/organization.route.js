import express from 'express';
import { body, query, param } from 'express-validator';
import { authenticate } from '../middlewares/auth.middleware.js';
import { tenantMiddleware, requireOrgRole, requireOrgPermission } from '../middlewares/tenant.middleware.js';
import { validateRequest } from '../middlewares/validate-request.middleware.js';
import { organizationController } from '../controllers/organization.controller.js';

const router = express.Router();

// Validation schemas
const createOrganizationValidation = [
  body('name')
    .trim()
    .isLength({ min: 2, max: 255 })
    .withMessage('Organization name must be between 2 and 255 characters'),
  
  body('slug')
    .optional()
    .trim()
    .matches(/^[a-z0-9-]+$/)
    .isLength({ min: 2, max: 50 })
    .withMessage('Slug must be 2-50 characters, lowercase letters, numbers, and hyphens only'),
  
  body('description')
    .optional()
    .trim()
    .isLength({ max: 1000 })
    .withMessage('Description must not exceed 1000 characters'),
  
  body('parentId')
    .optional()
    .isUUID()
    .withMessage('Parent ID must be a valid UUID'),
  
  body('settings')
    .optional()
    .isObject()
    .withMessage('Settings must be an object'),
  
  body('contactInfo')
    .optional()
    .isObject()
    .withMessage('Contact info must be an object'),
];

const updateOrganizationValidation = [
  body('name')
    .optional()
    .trim()
    .isLength({ min: 2, max: 255 })
    .withMessage('Organization name must be between 2 and 255 characters'),
  
  body('description')
    .optional()
    .trim()
    .isLength({ max: 1000 })
    .withMessage('Description must not exceed 1000 characters'),
  
  body('settings')
    .optional()
    .isObject()
    .withMessage('Settings must be an object'),
  
  body('contactInfo')
    .optional()
    .isObject()
    .withMessage('Contact info must be an object'),
];

const inviteUserValidation = [
  body('userFirebaseUid')
    .notEmpty()
    .withMessage('User Firebase UID is required'),
  
  body('role')
    .optional()
    .isIn(['owner', 'admin', 'manager', 'employee', 'viewer', 'guest'])
    .withMessage('Invalid role'),
  
  body('permissions')
    .optional()
    .isObject()
    .withMessage('Permissions must be an object'),
  
  body('department')
    .optional()
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('Department must be between 1 and 100 characters'),
  
  body('jobTitle')
    .optional()
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('Job title must be between 1 and 100 characters'),
];

const updateRoleValidation = [
  body('role')
    .isIn(['owner', 'admin', 'manager', 'employee', 'viewer', 'guest'])
    .withMessage('Invalid role'),
];

const membersListValidation = [
  query('page')
    .optional()
    .isInt({ min: 1 })
    .withMessage('Page must be a positive integer'),
  
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('Limit must be between 1 and 100'),
  
  query('role')
    .optional()
    .isIn(['owner', 'admin', 'manager', 'employee', 'viewer', 'guest'])
    .withMessage('Invalid role filter'),
  
  query('isActive')
    .optional()
    .isBoolean()
    .withMessage('isActive must be a boolean'),
  
  query('search')
    .optional()
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('Search term must be between 1 and 100 characters'),
];

const firebaseUidValidation = [
  param('userFirebaseUid')
    .notEmpty()
    .withMessage('User Firebase UID is required'),
];

// =============================================================================
// PUBLIC ROUTES (require authentication but no tenant context)
// =============================================================================

/**
 * @route   POST /api/v1/organizations
 * @desc    Create a new organization
 * @access  Private (Authenticated users)
 */
router.post('/', 
  authenticate,
  createOrganizationValidation,
  validateRequest,
  organizationController.createOrganization
);

/**
 * @route   GET /api/v1/organizations/my-organizations
 * @desc    Get user's organizations
 * @access  Private (Authenticated users)
 */
router.get('/my-organizations', 
  authenticate,
  organizationController.getUserOrganizations
);

// =============================================================================
// TENANT-SPECIFIC ROUTES (require organization context)
// =============================================================================

// Apply tenant middleware to all routes with :tenantSlug parameter
router.use('/:tenantSlug', authenticate, tenantMiddleware);

/**
 * @route   GET /api/v1/organizations/:tenantSlug
 * @desc    Get organization details
 * @access  Private (Organization members)
 */
router.get('/:tenantSlug', 
  organizationController.getOrganization
);

/**
 * @route   PUT /api/v1/organizations/:tenantSlug
 * @desc    Update organization
 * @access  Private (Organization owners/admins)
 */
router.put('/:tenantSlug',
  requireOrgRole(['owner', 'admin']),
  updateOrganizationValidation,
  validateRequest,
  organizationController.updateOrganization
);

/**
 * @route   GET /api/v1/organizations/:tenantSlug/dashboard
 * @desc    Get organization dashboard data
 * @access  Private (Organization members)
 */
router.get('/:tenantSlug/dashboard',
  organizationController.getDashboard
);

/**
 * @route   GET /api/v1/organizations/:tenantSlug/hierarchy
 * @desc    Get organization hierarchy
 * @access  Private (Organization members)
 */
router.get('/:tenantSlug/hierarchy',
  organizationController.getOrganizationHierarchy
);

// =============================================================================
// MEMBER MANAGEMENT ROUTES
// =============================================================================

/**
 * @route   GET /api/v1/organizations/:tenantSlug/members
 * @desc    Get organization members
 * @access  Private (Organization members)
 */
router.get('/:tenantSlug/members',
  membersListValidation,
  validateRequest,
  organizationController.getOrganizationMembers
);

/**
 * @route   POST /api/v1/organizations/:tenantSlug/members/invite
 * @desc    Invite user to organization
 * @access  Private (Organization owners/admins/managers)
 */
router.post('/:tenantSlug/members/invite',
  requireOrgRole(['owner', 'admin', 'manager']),
  inviteUserValidation,
  validateRequest,
  organizationController.inviteUser
);

/**
 * @route   DELETE /api/v1/organizations/:tenantSlug/members/:userFirebaseUid
 * @desc    Remove user from organization
 * @access  Private (Organization owners/admins/managers)
 */
router.delete('/:tenantSlug/members/:userFirebaseUid',
  requireOrgRole(['owner', 'admin', 'manager']),
  firebaseUidValidation,
  validateRequest,
  organizationController.removeUser
);

/**
 * @route   PUT /api/v1/organizations/:tenantSlug/members/:userFirebaseUid/role
 * @desc    Update user role in organization
 * @access  Private (Organization owners/admins/managers)
 */
router.put('/:tenantSlug/members/:userFirebaseUid/role',
  requireOrgRole(['owner', 'admin', 'manager']),
  firebaseUidValidation,
  updateRoleValidation,
  validateRequest,
  organizationController.updateUserRole
);

// =============================================================================
// SETTINGS ROUTES
// =============================================================================

/**
 * @route   GET /api/v1/organizations/:tenantSlug/settings
 * @desc    Get organization settings
 * @access  Private (Organization owners/admins)
 */
router.get('/:tenantSlug/settings',
  requireOrgRole(['owner', 'admin']),
  organizationController.getSettings
);

/**
 * @route   PUT /api/v1/organizations/:tenantSlug/settings
 * @desc    Update organization settings
 * @access  Private (Organization owners/admins)
 */
router.put('/:tenantSlug/settings',
  requireOrgRole(['owner', 'admin']),
  body('settings').optional().isObject().withMessage('Settings must be an object'),
  body('contactInfo').optional().isObject().withMessage('Contact info must be an object'),
  validateRequest,
  organizationController.updateSettings
);

// =============================================================================
// PERMISSION-BASED ROUTES (examples)
// =============================================================================

/**
 * @route   GET /api/v1/organizations/:tenantSlug/reports
 * @desc    Get organization reports
 * @access  Private (Users with reports.read permission)
 */
router.get('/:tenantSlug/reports',
  requireOrgPermission('reports', 'read'),
  (req, res) => {
    res.success({
      message: 'Reports endpoint - implementation pending',
      data: {
        organization: req.tenant.name,
        userRole: req.orgRole,
        hasReportsAccess: true
      }
    });
  }
);

/**
 * @route   GET /api/v1/organizations/:tenantSlug/billing
 * @desc    Get organization billing information
 * @access  Private (Users with billing.read permission)
 */
router.get('/:tenantSlug/billing',
  requireOrgPermission('billing', 'read'),
  (req, res) => {
    res.success({
      message: 'Billing endpoint - implementation pending',
      data: {
        organization: req.tenant.name,
        planType: req.tenant.planType,
        userRole: req.orgRole,
        hasBillingAccess: true
      }
    });
  }
);

export default router;
