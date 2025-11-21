# Multi-Tenant Architecture Guide - Mordecai API

## 🏢 Overview

Mordecai API now supports **multi-tenant architecture** where organizations can have hierarchical structures (companies with sub-companies) and users can belong to multiple organizations with different roles and permissions.

### Key Features

- **Firebase Authentication Preserved**: All existing Firebase auth (email/password, Google sign-in) works unchanged
- **Organization Hierarchy**: Companies can have sub-companies with unlimited depth
- **Flexible Memberships**: Users can belong to multiple organizations with different roles
- **Granular Permissions**: Role-based + custom permissions per organization
- **Gradual Database Sync**: Safe table-by-table synchronization
- **Feature Flags**: Enable/disable multi-tenant features dynamically

## 🏗️ Architecture Overview

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────────┐
│   Firebase      │    │   PostgreSQL     │    │   Organization      │
│   Authentication│    │   User Data      │    │   Context           │
│                 │    │                  │    │                     │
│ • Email/Password│    │ • systemRole     │    │ • Tenant Middleware │
│ • Google Sign-in│    │ • displayName    │    │ • Role-based Access │
│ • JWT Tokens    │    │ • isActive       │    │ • Permissions       │
│ • Profile Data  │    │ • lastLoginAt    │    │ • Hierarchy         │
└─────────────────┘    └──────────────────┘    └─────────────────────┘
         │                       │                        │
         └───────────────────────┼────────────────────────┘
                                 │
                    ┌─────────────────────┐
                    │   Multi-Tenant      │
                    │   Request Flow      │
                    │                     │
                    │ 1. Firebase Auth    │
                    │ 2. Tenant Context   │
                    │ 3. Permission Check │
                    │ 4. Business Logic   │
                    └─────────────────────┘
```

## 🚀 Quick Start

### 1. Enable Multi-Tenant Features

```bash
# .env
ENABLE_MULTI_TENANT=true
SYNC_ORGANIZATIONS=true
SYNC_ORG_USERS=true

# Optional settings
DEFAULT_ORG_SLUG=default
MAX_ORGS_PER_USER=10
ALLOW_ORG_CREATION=true
REQUIRE_ORG_INVITE=false
```

### 2. Start the Application

```bash
npm start
```

The system will automatically:
- ✅ Sync the `users` table (existing)
- ✅ Create the `organizations` table (new)
- ✅ Create the `organization_users` table (new)
- ✅ Setup model associations

### 3. Create Your First Organization

```bash
curl -X POST http://localhost:3000/api/v1/organizations \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Acme Corporation",
    "slug": "acme-corp",
    "description": "Leading provider of innovative solutions"
  }'
```

### 4. Access Organization Context

```bash
# Using URL parameter
curl -X GET http://localhost:3000/api/v1/org/acme-corp/dashboard \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"

# Using header
curl -X GET http://localhost:3000/api/v1/organizations/dashboard \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "X-Tenant-ID: acme-corp"
```

## 📊 Database Schema

### Core Tables

#### 1. Users Table (Enhanced)
```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firebase_uid VARCHAR(255) UNIQUE NOT NULL,
  display_name VARCHAR(255),
  system_role ENUM('super_admin', 'system_admin', 'user') DEFAULT 'user',
  app_role ENUM('user', 'admin', 'moderator', 'manager', 'editor'), -- Legacy
  is_active BOOLEAN DEFAULT true,
  last_login_at TIMESTAMP,
  login_attempts INTEGER DEFAULT 0,
  locked_until TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP -- Soft delete
);
```

#### 2. Organizations Table (New)
```sql
CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(50) UNIQUE NOT NULL,
  description TEXT,
  parent_id UUID REFERENCES organizations(id), -- Hierarchy support
  settings JSONB DEFAULT '{}',
  contact_info JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  plan_type ENUM('free', 'basic', 'premium', 'enterprise') DEFAULT 'free',
  founded_at TIMESTAMP,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP -- Soft delete
);
```

#### 3. Organization Users Table (New)
```sql
CREATE TABLE organization_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  role ENUM('owner', 'admin', 'manager', 'employee', 'viewer', 'guest') DEFAULT 'employee',
  permissions JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  invited_by UUID REFERENCES users(id),
  invited_at TIMESTAMP,
  joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  department VARCHAR(100),
  job_title VARCHAR(100),
  custom_fields JSONB DEFAULT '{}',
  last_access_at TIMESTAMP,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP, -- Soft delete
  UNIQUE(user_id, organization_id)
);
```

## 🔐 Authentication Flow

### 1. Firebase Authentication (Unchanged)
```javascript
// Register with email/password
POST /api/v1/auth/register
{
  "email": "user@company.com",
  "password": "Password123!",
  "firstName": "John",
  "lastName": "Doe",
  "displayName": "John Doe"
}

// Login with Google
POST /api/v1/auth/google-login
{
  "idToken": "firebase-google-id-token"
}
```

### 2. Organization Context (New)
```javascript
// Get user's organizations
GET /api/v1/organizations/my-organizations
Authorization: Bearer <firebase-jwt-token>

// Access specific organization
GET /api/v1/org/acme-corp/dashboard
Authorization: Bearer <firebase-jwt-token>
```

## 🏢 Organization Management

### Creating Organizations

```javascript
// Create root organization
POST /api/v1/organizations
{
  "name": "Acme Corporation",
  "slug": "acme-corp",
  "description": "Leading provider of innovative solutions",
  "settings": {
    "features": {
      "userManagement": true,
      "reporting": true,
      "apiAccess": false
    },
    "branding": {
      "primaryColor": "#007bff",
      "logo": null
    }
  },
  "contactInfo": {
    "email": "contact@acme-corp.com",
    "phone": "+1-555-0123",
    "address": "123 Business St, City, State 12345"
  }
}
```

```javascript
// Create sub-organization
POST /api/v1/organizations
{
  "name": "Acme Europe",
  "slug": "acme-europe",
  "description": "European division",
  "parentId": "parent-organization-uuid"
}
```

### Organization Hierarchy

```javascript
// Get organization hierarchy
GET /api/v1/org/acme-corp/hierarchy

// Response:
{
  "success": true,
  "data": {
    "organization": {
      "id": "uuid",
      "name": "Acme Corporation",
      "slug": "acme-corp",
      "subOrganizations": [
        {
          "id": "uuid",
          "name": "Acme Europe",
          "slug": "acme-europe"
        }
      ]
    },
    "hierarchyPath": [
      { "id": "uuid", "name": "Acme Corporation", "slug": "acme-corp" }
    ]
  }
}
```

## 👥 User Management

### Organization Roles

| Role | Description | Default Permissions |
|------|-------------|-------------------|
| `owner` | Organization owner | Full access to everything |
| `admin` | Administrator | Almost full access, cannot delete org |
| `manager` | Manager | User management, reports, settings |
| `employee` | Regular employee | Basic access to organization |
| `viewer` | Read-only access | Can view but not modify |
| `guest` | Limited access | Minimal permissions |

### Inviting Users

```javascript
// Invite user to organization
POST /api/v1/org/acme-corp/members/invite
{
  "userFirebaseUid": "firebase-user-uid",
  "role": "employee",
  "department": "Engineering",
  "jobTitle": "Software Developer",
  "permissions": {
    "reports": { "read": true, "write": false }
  }
}
```

### Managing Members

```javascript
// Get organization members
GET /api/v1/org/acme-corp/members?page=1&limit=20&role=employee&search=john

// Update user role
PUT /api/v1/org/acme-corp/members/firebase-uid/role
{
  "role": "manager"
}

// Remove user from organization
DELETE /api/v1/org/acme-corp/members/firebase-uid
```

## 🔒 Permissions System

### Role-Based Permissions

```javascript
// Default permissions by role
const rolePermissions = {
  owner: {
    users: { read: true, write: true, delete: true, invite: true },
    organizations: { read: true, write: true, delete: true, settings: true },
    reports: { read: true, write: true, export: true },
    billing: { read: true, write: true },
    api: { read: true, write: true }
  },
  admin: {
    users: { read: true, write: true, delete: true, invite: true },
    organizations: { read: true, write: true, delete: false, settings: true },
    reports: { read: true, write: true, export: true },
    billing: { read: true, write: false },
    api: { read: true, write: true }
  },
  // ... other roles
};
```

### Custom Permissions

```javascript
// Grant specific permission
await orgMembership.grantPermission('reports', 'export');

// Check permission
if (req.orgMembership.hasPermission('users', 'write')) {
  // User can manage users
}

// Middleware for permission-based routes
router.get('/reports', 
  requireOrgPermission('reports', 'read'),
  reportsController.getReports
);
```

## 🛣️ API Routes

### Public Routes (No Tenant Context)
```
POST   /api/v1/organizations                    # Create organization
GET    /api/v1/organizations/my-organizations   # Get user's organizations
```

### Tenant-Specific Routes (Require Organization Context)
```
GET    /api/v1/org/:slug                        # Get organization details
PUT    /api/v1/org/:slug                        # Update organization
GET    /api/v1/org/:slug/dashboard              # Get dashboard data
GET    /api/v1/org/:slug/hierarchy              # Get organization hierarchy
GET    /api/v1/org/:slug/members                # Get organization members
POST   /api/v1/org/:slug/members/invite         # Invite user
DELETE /api/v1/org/:slug/members/:uid           # Remove user
PUT    /api/v1/org/:slug/members/:uid/role      # Update user role
GET    /api/v1/org/:slug/settings               # Get organization settings
PUT    /api/v1/org/:slug/settings               # Update organization settings
```

### Permission-Based Routes
```
GET    /api/v1/org/:slug/reports                # Requires reports.read
GET    /api/v1/org/:slug/billing                # Requires billing.read
```

## 🔧 Middleware Chain

### Request Flow
```javascript
// 1. Firebase Authentication (unchanged)
authenticate(req, res, next)

// 2. Tenant Context (new)
tenantMiddleware(req, res, next)

// 3. Role/Permission Check (new)
requireOrgRole(['admin', 'manager'])(req, res, next)
// OR
requireOrgPermission('users', 'write')(req, res, next)

// 4. Controller Logic
organizationController.someAction(req, res, next)
```

### Tenant Context Detection
```javascript
// Priority order:
// 1. URL parameter: /org/:tenantSlug
// 2. Header: X-Tenant-ID: acme-corp
// 3. Subdomain: acme-corp.yourdomain.com
```

## 🎛️ Configuration

### Environment Variables
```bash
# Multi-tenant feature flags
ENABLE_MULTI_TENANT=true
LEGACY_MODE=false

# Database sync control
SYNC_USERS=true
SYNC_ORGANIZATIONS=true
SYNC_ORG_USERS=true

# Multi-tenant settings
DEFAULT_ORG_SLUG=default
MAX_ORGS_PER_USER=10
ALLOW_ORG_CREATION=true
REQUIRE_ORG_INVITE=false
```

### Feature Flags in Code
```javascript
import { config } from '../config/index.js';

if (config.features.multiTenant) {
  // Multi-tenant logic
} else {
  // Legacy single-tenant logic
}
```

## 🔄 Migration Strategy

### Phase 1: Enable Tables Only
```bash
ENABLE_MULTI_TENANT=true
SYNC_ORGANIZATIONS=true
SYNC_ORG_USERS=false  # Don't create junction table yet
```

### Phase 2: Enable Full Multi-Tenant
```bash
SYNC_ORG_USERS=true   # Now create junction table
```

### Phase 3: Migrate Existing Users
```javascript
// Create default organization
const defaultOrg = await Organization.create({
  name: 'Default Organization',
  slug: 'default',
  isActive: true
});

// Migrate existing users
const users = await User.findAll();
for (const user of users) {
  await OrganizationUser.create({
    userId: user.id,
    organizationId: defaultOrg.id,
    role: user.appRole === 'admin' ? 'owner' : 'employee',
    isActive: true,
    joinedAt: user.createdAt
  });
}
```

## 🧪 Testing

### Unit Tests
```javascript
describe('Multi-Tenant Organization', () => {
  test('should create organization with owner', async () => {
    const user = await createTestUser();
    const org = await organizationService.createOrganization({
      name: 'Test Corp',
      slug: 'test-corp'
    }, user.id);
    
    expect(org.name).toBe('Test Corp');
    
    const membership = await OrganizationUser.findOne({
      where: { userId: user.id, organizationId: org.id }
    });
    
    expect(membership.role).toBe('owner');
  });
});
```

### Integration Tests
```javascript
describe('Tenant Middleware', () => {
  test('should add tenant context to request', async () => {
    const response = await request(app)
      .get('/api/v1/org/test-corp/dashboard')
      .set('Authorization', `Bearer ${userToken}`)
      .expect(200);
    
    expect(response.body.data.organization.slug).toBe('test-corp');
  });
});
```

## 🚨 Security Considerations

### 1. Tenant Isolation
- ✅ All data queries are scoped to organization
- ✅ Users cannot access other organizations without membership
- ✅ Super admins can bypass restrictions (for system management)

### 2. Permission Validation
- ✅ Role-based access control per organization
- ✅ Granular permissions override role defaults
- ✅ Permission checks on every sensitive operation

### 3. Data Protection
- ✅ Soft delete prevents accidental data loss
- ✅ Audit trails for organization changes
- ✅ Firebase authentication remains secure

## 📈 Performance Optimizations

### 1. Database Queries
- **Efficient joins** between users and organizations
- **Proper indexing** on foreign keys and search fields
- **Pagination** for large member lists
- **Selective loading** of organization data

### 2. Caching Strategy
```javascript
// Cache user organizations
const userOrgs = await redis.get(`user:${userId}:orgs`);
if (!userOrgs) {
  const orgs = await organizationService.getUserOrganizations(userId);
  await redis.setex(`user:${userId}:orgs`, 300, JSON.stringify(orgs));
}
```

### 3. Request Optimization
- **Tenant context caching** during request lifecycle
- **Permission memoization** for repeated checks
- **Lazy loading** of organization hierarchy

## 🔮 Future Enhancements

### Planned Features
1. **Organization Templates** - Pre-configured organization types
2. **Bulk User Import** - CSV/Excel import for large teams
3. **Advanced Permissions** - Resource-level permissions
4. **Organization Analytics** - Usage and activity metrics
5. **API Rate Limiting** - Per-organization rate limits
6. **Webhook System** - Organization event notifications
7. **SSO Integration** - SAML/OIDC for enterprise customers

### Scalability Improvements
1. **Database Sharding** - Partition by organization
2. **Microservices** - Split organization management
3. **Event Sourcing** - Track all organization changes
4. **CQRS Pattern** - Separate read/write models

## 🆘 Troubleshooting

### Common Issues

#### 1. Tables Not Created
```bash
# Check feature flags
echo $ENABLE_MULTI_TENANT  # Should be 'true'
echo $SYNC_ORGANIZATIONS   # Should be 'true'

# Check logs
tail -f logs/app.log | grep -i "sync"
```

#### 2. Tenant Context Missing
```bash
# Verify middleware order
# authenticate MUST come before tenantMiddleware

# Check tenant identifier
curl -X GET /api/v1/org/your-slug/dashboard \
  -H "Authorization: Bearer token" \
  -v  # Check if slug is correct
```

#### 3. Permission Denied
```javascript
// Check user membership
const membership = await OrganizationUser.findOne({
  where: { userId, organizationId }
});
console.log('User role:', membership?.role);
console.log('User permissions:', membership?.permissions);
```

### Debug Mode
```bash
# Enable debug logging
DEBUG=mordecai:* npm start

# Or specific modules
DEBUG=mordecai:tenant,mordecai:org npm start
```

## 📚 Additional Resources

- [Firebase Authentication Docs](https://firebase.google.com/docs/auth)
- [PostgreSQL JSON Functions](https://www.postgresql.org/docs/current/functions-json.html)
- [Sequelize Associations](https://sequelize.org/docs/v6/core-concepts/assocs/)
- [Multi-Tenant Architecture Patterns](https://docs.microsoft.com/en-us/azure/sql-database/saas-tenancy-app-design-patterns)

---

🎉 **Congratulations!** You now have a fully functional multi-tenant system that preserves all Firebase authentication while adding powerful organization management capabilities!
