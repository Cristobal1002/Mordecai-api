# Postman Multi-Tenant Collection Guide - Mordecai API

## 🚀 Updated Postman Collection

The Postman collection has been updated to **version 2.0.0** with complete multi-tenant organization management support while preserving all existing Firebase authentication functionality.

## 📦 **What's New**

### **New Collections Added:**
1. **Multi-Tenant Organizations** - Core organization management
2. **Organization Members** - Member management and invitations
3. **Organization Settings** - Configuration and settings
4. **Permission-Based Endpoints** - Examples of permission-based access
5. **Multi-Tenant Examples** - Different ways to access tenant context

### **New Environment Variables:**
- `TENANT_SLUG` - Organization slug (e.g., "acme-corp")
- `ORGANIZATION_ID` - Organization UUID
- `PARENT_ORG_ID` - Parent organization UUID for sub-orgs
- `USER_FIREBASE_UID` - Firebase UID for member operations

## 🔧 **Setup Instructions**

### 1. Import Updated Collection
```bash
# Import the updated collection file
docs/postman-collection.json
```

### 2. Import Updated Environment
```bash
# Import the updated environment file
docs/postman-environment.json
```

### 3. Configure Environment Variables
Set these variables in your Postman environment:

| Variable | Example Value | Description |
|----------|---------------|-------------|
| `BASE_URL` | `http://localhost:3000` | API base URL |
| `API_VERSION` | `v1` | API version |
| `ACCESS_TOKEN` | `eyJhbGciOiJIUzI1NiIs...` | JWT access token |
| `TENANT_SLUG` | `acme-corp` | Organization slug |
| `ORGANIZATION_ID` | `uuid-here` | Organization UUID |
| `USER_FIREBASE_UID` | `firebase-uid` | User Firebase UID |

## 🏢 **Multi-Tenant Workflow**

### **Step 1: Authenticate (Unchanged)**
1. **Register with Email** or **Login with Email/Google**
2. Copy the `accessToken` from response
3. Set `ACCESS_TOKEN` environment variable

### **Step 2: Create Your First Organization**
1. Use **"Create Organization"** request
2. Copy the `slug` from response (e.g., "acme-corp")
3. Set `TENANT_SLUG` environment variable
4. Copy the `id` from response
5. Set `ORGANIZATION_ID` environment variable

### **Step 3: Access Organization Context**
Now you can use any tenant-specific endpoint:
- **Get Organization Details**
- **Get Organization Dashboard**
- **Get Organization Members**
- etc.

## 📋 **Collection Structure**

### **1. Authentication** (Existing - Unchanged)
- Register with Email
- Login with Email
- Login with Google
- Refresh Token
- Logout
- Reset Password
- Verify Email

### **2. User Management** (Existing - Enhanced)
- Get User Profile
- Update User Preferences
- Get Users List (Advanced)
- Get Users Overview
- Update User Role (Admin)
- Deactivate User (Admin)
- Delete User (Admin)
- Restore User (Admin)
- Permanent Delete User (Admin)
- Get Deleted Users (Admin)
- Get User Stats (Admin)

### **3. Multi-Tenant Organizations** (NEW)
- **Create Organization** - Create new organization
- **Create Sub-Organization** - Create child organization
- **Get My Organizations** - List user's organizations
- **Get Organization Details** - Organization info + membership
- **Update Organization** - Update org details (owners/admins)
- **Get Organization Dashboard** - Dashboard data
- **Get Organization Hierarchy** - Parent/child relationships

### **4. Organization Members** (NEW)
- **Get Organization Members** - Paginated member list with filters
- **Invite User to Organization** - Send invitations
- **Update User Role** - Change member roles
- **Remove User from Organization** - Remove members
- **Search Organization Members** - Search by name/email
- **Filter Members by Role** - Filter by role and status

### **5. Organization Settings** (NEW)
- **Get Organization Settings** - Configuration and contact info
- **Update Organization Settings** - Update settings (owners/admins)

### **6. Permission-Based Endpoints** (NEW)
- **Get Organization Reports** - Requires `reports.read` permission
- **Get Organization Billing** - Requires `billing.read` permission

### **7. Multi-Tenant Examples** (NEW)
- **Access via URL Parameter** - `/org/acme-corp/dashboard`
- **Access via Header** - `X-Tenant-ID: acme-corp`
- **Complete Workflow Example** - Step-by-step guide

### **8. Health Check** (Existing)
- Health Check endpoint

## 🎯 **Usage Examples**

### **Example 1: Complete Organization Setup**

1. **Authenticate**
   ```
   POST /api/v1/auth/login
   ```

2. **Create Organization**
   ```
   POST /api/v1/organizations
   Body: {
     "name": "My Company",
     "slug": "my-company"
   }
   ```

3. **Set Environment Variables**
   - `TENANT_SLUG` = "my-company"
   - `ORGANIZATION_ID` = response.id

4. **Access Organization**
   ```
   GET /api/v1/org/my-company/dashboard
   ```

### **Example 2: Member Management**

1. **Get Current Members**
   ```
   GET /api/v1/org/{{TENANT_SLUG}}/members
   ```

2. **Invite New Member**
   ```
   POST /api/v1/org/{{TENANT_SLUG}}/members/invite
   Body: {
     "userFirebaseUid": "firebase-uid-here",
     "role": "employee"
   }
   ```

3. **Update Member Role**
   ```
   PUT /api/v1/org/{{TENANT_SLUG}}/members/{{USER_FIREBASE_UID}}/role
   Body: {
     "role": "manager"
   }
   ```

### **Example 3: Organization Hierarchy**

1. **Create Parent Organization**
   ```
   POST /api/v1/organizations
   Body: {
     "name": "Acme Corporation",
     "slug": "acme-corp"
   }
   ```

2. **Create Sub-Organization**
   ```
   POST /api/v1/organizations
   Body: {
     "name": "Acme Europe",
     "slug": "acme-europe",
     "parentId": "{{PARENT_ORG_ID}}"
   }
   ```

3. **View Hierarchy**
   ```
   GET /api/v1/org/acme-corp/hierarchy
   ```

## 🔐 **Role-Based Testing**

### **Owner Role Testing**
- Can create/update/delete organizations
- Can manage all members
- Can access all settings
- Can view billing information

### **Admin Role Testing**
- Can manage members
- Can update organization settings
- Cannot delete organization
- Can view most reports

### **Manager Role Testing**
- Can invite/remove members
- Can view member list
- Cannot access billing
- Can view basic reports

### **Employee Role Testing**
- Can view organization details
- Can view member list (read-only)
- Cannot manage members
- Limited report access

## 🛠️ **Advanced Features**

### **Search and Filtering**
```
GET /api/v1/org/{{TENANT_SLUG}}/members?search=john&role=admin&isActive=true
```

### **Pagination**
```
GET /api/v1/org/{{TENANT_SLUG}}/members?page=2&limit=10
```

### **Permission-Based Access**
```
GET /api/v1/org/{{TENANT_SLUG}}/reports
# Requires reports.read permission
```

### **Multiple Access Methods**
```
# Method 1: URL Parameter (recommended)
GET /api/v1/org/acme-corp/dashboard

# Method 2: Header
GET /api/v1/organizations/dashboard
Headers: X-Tenant-ID: acme-corp
```

## 🧪 **Testing Scenarios**

### **Scenario 1: New Organization Setup**
1. Register new user
2. Create organization
3. Verify owner permissions
4. Invite team members
5. Test member permissions

### **Scenario 2: Multi-Organization User**
1. Create multiple organizations
2. Switch between organizations
3. Test different roles in each org
4. Verify data isolation

### **Scenario 3: Organization Hierarchy**
1. Create parent organization
2. Create multiple sub-organizations
3. Test inheritance and permissions
4. Verify hierarchy navigation

### **Scenario 4: Permission Testing**
1. Create users with different roles
2. Test each endpoint with each role
3. Verify permission enforcement
4. Test custom permissions

## 🚨 **Common Issues & Solutions**

### **Issue 1: Tenant Context Missing**
```
Error: "Organization context required"
```
**Solution**: Ensure `TENANT_SLUG` is set and user has access to organization

### **Issue 2: Permission Denied**
```
Error: "Insufficient organization permissions"
```
**Solution**: Check user's role in organization and required permissions

### **Issue 3: User Not Found**
```
Error: "User not found or inactive"
```
**Solution**: Verify `USER_FIREBASE_UID` is correct and user exists

### **Issue 4: Organization Not Found**
```
Error: "Organization not found or inactive"
```
**Solution**: Check `TENANT_SLUG` spelling and organization status

## 📊 **Environment Variables Reference**

### **Core Variables (Required)**
- `BASE_URL` - API base URL
- `API_VERSION` - API version (v1)
- `ACCESS_TOKEN` - JWT token from authentication

### **Multi-Tenant Variables (New)**
- `TENANT_SLUG` - Organization identifier for URLs
- `ORGANIZATION_ID` - Organization UUID for API calls
- `PARENT_ORG_ID` - Parent organization for sub-org creation
- `USER_FIREBASE_UID` - Target user for member operations

### **Legacy Variables (Existing)**
- `REFRESH_TOKEN` - JWT refresh token
- `GOOGLE_ID_TOKEN` - Google authentication token
- `EMAIL_VERIFICATION_TOKEN` - Email verification token
- `TARGET_FIREBASE_UID` - Target user for admin operations

## 🎉 **Ready to Test!**

The updated Postman collection provides comprehensive testing capabilities for:

- ✅ **Complete Firebase Authentication** (unchanged)
- ✅ **Multi-Tenant Organization Management** (new)
- ✅ **Hierarchical Organization Structure** (new)
- ✅ **Role-Based Permission System** (new)
- ✅ **Member Management & Invitations** (new)
- ✅ **Organization Settings & Configuration** (new)

Import the collection, set your environment variables, and start testing the full multi-tenant functionality!

---

**Happy Testing! 🚀**
