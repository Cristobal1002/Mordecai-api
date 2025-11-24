# Users List API - Mordecai

## Overview

The Users List API provides comprehensive functionality to query, filter, search, and manage users from the PostgreSQL database with Firebase data integration.

## Endpoints

### 1. Get Users List (Advanced)

**Endpoint:** `GET /api/v1/users`  
**Access:** System Admin only  
**Description:** Get paginated users list with advanced filtering, search, and sorting capabilities.

#### Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | integer | 1 | Page number (min: 1) |
| `limit` | integer | 20 | Results per page (1-100) |
| `systemRole` | string | - | Filter by system role: `super_admin`, `system_admin`, `user` |
| `isActive` | boolean | - | Filter by active status |
| `search` | string | - | Search in email, displayName, systemRole, firebaseUid |
| `sortBy` | string | createdAt | Sort field: `createdAt`, `updatedAt`, `lastLoginAt`, `systemRole` |
| `sortOrder` | string | DESC | Sort order: `ASC` or `DESC` |
| `includeDeleted` | boolean | false | Include soft deleted users |
| `dateFrom` | string | - | Filter users created after this date (ISO format) |
| `dateTo` | string | - | Filter users created before this date (ISO format) |

#### Example Requests

**Basic List:**
```http
GET /api/v1/users?page=1&limit=20
Authorization: Bearer <admin-token>
```

**Advanced Filtering:**
```http
GET /api/v1/users?systemRole=user&isActive=true&sortBy=lastLoginAt&sortOrder=DESC&limit=50
Authorization: Bearer <system-admin-token>
```

**Search Users:**
```http
GET /api/v1/users?search=john&page=1&limit=10
Authorization: Bearer <admin-token>
```

**Date Range Filter:**
```http
GET /api/v1/users?dateFrom=2024-01-01&dateTo=2024-12-31&sortBy=createdAt
Authorization: Bearer <admin-token>
```

**Include Deleted Users:**
```http
GET /api/v1/users?includeDeleted=true&sortBy=updatedAt&sortOrder=DESC
Authorization: Bearer <admin-token>
```

#### Response Format

```json
{
  "success": true,
  "message": "Users list retrieved successfully",
  "data": {
    "users": [
      {
        "id": "uuid",
        "firebaseUid": "firebase-uid",
        "displayName": "John Doe", // From PostgreSQL (prioritized) or Firebase fallback
        "systemRole": "user",
        "isActive": true,
        "lastLoginAt": "2024-01-15T10:30:00Z",
        "createdAt": "2024-01-01T00:00:00Z",
        "updatedAt": "2024-01-15T10:30:00Z",
        "deletedAt": null,
        
        // Firebase data (fetched dynamically)
        "email": "user@example.com",
        "emailVerified": true,
        "photoURL": "https://...",
        "disabled": false,
        "metadata": {
          "creationTime": "2024-01-01T00:00:00Z",
          "lastSignInTime": "2024-01-15T10:30:00Z"
        }
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 150,
      "pages": 8,
      "hasNext": true,
      "hasPrev": false
    },
    "filters": {
      "systemRole": "user",
      "isActive": true,
      "search": null,
      "sortBy": "createdAt",
      "sortOrder": "DESC",
      "includeDeleted": false,
      "dateFrom": null,
      "dateTo": null
    },
    "summary": {
      "totalUsers": 150,
      "currentPage": 1,
      "resultsPerPage": 20
    }
  }
}
```

### 2. Get Users Overview

**Endpoint:** `GET /api/v1/users/overview`  
**Access:** System Admin only  
**Description:** Get dashboard summary with user statistics and distributions.

#### Example Request

```http
GET /api/v1/users/overview
Authorization: Bearer <admin-token>
```

#### Response Format

```json
{
  "success": true,
  "message": "Users overview retrieved successfully",
  "data": {
    "overview": {
      "totalUsers": 1000,
      "activeUsers": 950,
      "inactiveUsers": 50,
      "recentSignups": 25
    },
    "roleDistribution": {
      "super_admin": 2,
      "system_admin": 8,
      "user": 990
    },
    "statusDistribution": {
      "active": 950,
      "inactive": 50
    },
    "recentUsers": [
      {
        "id": "uuid",
        "firebaseUid": "firebase-uid",
        "systemRole": "user",
        "displayName": "John Doe",
        "isActive": true,
        "createdAt": "2024-01-15T10:30:00Z"
      }
    ],
    "activeUsers": [
      {
        "id": "uuid",
        "firebaseUid": "firebase-uid",
        "systemRole": "user",
        "displayName": "John Doe",
        "lastLoginAt": "2024-01-15T10:30:00Z"
      }
    ]
  }
}
```

## Performance Optimizations

### Database Queries

1. **Efficient Filtering:** Uses PostgreSQL indexes on `appRole`, `isActive`, `createdAt`
2. **Pagination:** LIMIT/OFFSET for memory efficiency
3. **Selective Firebase Calls:** Only fetches Firebase data for returned users
4. **Aggregated Queries:** Overview uses GROUP BY for statistics

### Indexes Used

```sql
-- Existing indexes for optimal performance
CREATE INDEX idx_users_system_role ON users(system_role);
CREATE INDEX idx_users_is_active ON users(is_active);
CREATE INDEX idx_users_created_at ON users(created_at);
CREATE INDEX idx_users_last_login ON users(last_login_at);
CREATE INDEX idx_users_deleted_at ON users(deleted_at);
```

### Search Implementation

- **PostgreSQL First:** Filters applied at database level
- **PostgreSQL displayName:** Prioritized over Firebase displayName for consistency
- **Firebase Search:** Applied after data enrichment for email/displayName
- **Efficient:** Only searches in returned result set

## Use Cases

### 1. Admin Dashboard
```javascript
// Get overview for dashboard
const overview = await fetch('/api/v1/users/overview');

// Get recent users
const recentUsers = await fetch('/api/v1/users?sortBy=createdAt&limit=10');
```

### 2. User Management Interface
```javascript
// Paginated user list
const users = await fetch('/api/v1/users?page=1&limit=25&sortBy=lastLoginAt');

// Search users
const searchResults = await fetch('/api/v1/users?search=john&limit=10');

// Filter by system role
const systemAdmins = await fetch('/api/v1/users?systemRole=system_admin&sortBy=createdAt');
```

### 3. Reporting & Analytics
```javascript
// Users created in date range
const monthlyUsers = await fetch('/api/v1/users?dateFrom=2024-01-01&dateTo=2024-01-31');

// Include deleted for audit
const allUsers = await fetch('/api/v1/users?includeDeleted=true&sortBy=updatedAt');

// Inactive users analysis
const inactiveUsers = await fetch('/api/v1/users?isActive=false&sortBy=lastLoginAt');
```

## Error Handling

### Common Errors

**403 Insufficient Permissions:**
```json
{
  "success": false,
  "message": "Insufficient permissions",
  "error": {
    "code": "INSUFFICIENT_PERMISSIONS",
    "details": "Only admin or moderator can access users list"
  }
}
```

**400 Validation Error:**
```json
{
  "success": false,
  "message": "Validation failed",
  "error": {
    "code": "VALIDATION_ERROR",
    "details": [
      {
        "field": "limit",
        "message": "Limit must be between 1 and 100"
      }
    ]
  }
}
```

**500 Firebase Error:**
```json
{
  "success": false,
  "message": "Error retrieving user data",
  "error": {
    "code": "FIREBASE_ERROR",
    "details": "Firebase service temporarily unavailable"
  }
}
```

## Security Features

### 1. Role-Based Access
- Only `super_admin` and `system_admin` roles can access
- Verified through JWT token and database lookup

### 2. Data Protection
- Sensitive fields excluded from responses
- Firebase data fetched securely
- Soft deleted users require explicit flag

### 3. Rate Limiting
- Standard API rate limits apply
- Additional protection for admin endpoints

## Frontend Integration Examples

### React Hook
```javascript
import { useState, useEffect } from 'react';

const useUsersList = (filters = {}) => {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [pagination, setPagination] = useState({});

  const fetchUsers = async (params = {}) => {
    setLoading(true);
    try {
      const queryParams = new URLSearchParams({ ...filters, ...params });
      const response = await fetch(`/api/v1/users?${queryParams}`, {
        headers: {
          'Authorization': `Bearer ${getToken()}`,
        },
      });
      
      const data = await response.json();
      setUsers(data.data.users);
      setPagination(data.data.pagination);
    } catch (error) {
      console.error('Error fetching users:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  return { users, loading, pagination, refetch: fetchUsers };
};
```

### Vue.js Composable
```javascript
import { ref, reactive } from 'vue';

export function useUsersList() {
  const users = ref([]);
  const loading = ref(false);
  const pagination = reactive({});
  const filters = reactive({
    page: 1,
    limit: 20,
    search: '',
    systemRole: '',
    sortBy: 'createdAt',
    sortOrder: 'DESC'
  });

  const fetchUsers = async () => {
    loading.value = true;
    try {
      const params = new URLSearchParams(filters);
      const response = await $fetch(`/api/v1/users?${params}`);
      
      users.value = response.data.users;
      Object.assign(pagination, response.data.pagination);
    } catch (error) {
      console.error('Error fetching users:', error);
    } finally {
      loading.value = false;
    }
  };

  return {
    users,
    loading,
    pagination,
    filters,
    fetchUsers
  };
}
```

## Best Practices

### 1. Efficient Queries
- Use appropriate page sizes (10-50 users)
- Apply filters at database level
- Cache overview data when possible

### 2. Search Implementation
- Debounce search input (300ms)
- Minimum search length (2-3 characters)
- Clear search results appropriately

### 3. Error Handling
- Handle Firebase service outages gracefully
- Provide fallback data when possible
- Show meaningful error messages

### 4. Performance
- Implement client-side caching
- Use virtual scrolling for large lists
- Lazy load Firebase data when needed

This Users List API provides comprehensive functionality for managing and querying users efficiently in the Mordecai application! 🚀
