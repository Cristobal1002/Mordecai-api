# Mordecai API Documentation

## Overview

Mordecai provides comprehensive authentication functionality using Firebase Authentication with support for:
- Email/Password registration and login
- Google Sign-In integration
- JWT token management
- Password reset functionality
- Email verification
- Account security features (login attempts, account locking)

## Base URL

```
http://localhost:3000/api/v1
```

## Authentication

Most endpoints require authentication via Bearer token in the Authorization header:

```
Authorization: Bearer <your-jwt-token>
```

## Endpoints

### Authentication Endpoints

#### POST /auth/register

Register a new user with email and password.

**Request Body:**
```json
{
  "email": "user@example.com",
  "password": "Password123!",
  "firstName": "John",
  "lastName": "Doe",
  "displayName": "John Doe" // Optional - will use firstName + lastName if not provided
}
```

**Response:**
```json
{
  "success": true,
  "message": "User registered successfully",
  "data": {
    "user": {
      "id": "uuid",
      "email": "user@example.com",
      "firstName": "John",
      "lastName": "Doe",
      "provider": "email",
      "emailVerified": false,
      "isActive": true,
      "createdAt": "2023-01-01T00:00:00.000Z",
      "updatedAt": "2023-01-01T00:00:00.000Z"
    },
    "tokens": {
      "accessToken": "jwt-access-token",
      "refreshToken": "jwt-refresh-token"
    }
  }
}
```

#### POST /auth/login

Login with email and password.

**Request Body:**
```json
{
  "email": "user@example.com",
  "password": "Password123!"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Login successful",
  "data": {
    "user": { /* user object */ },
    "tokens": {
      "accessToken": "jwt-access-token",
      "refreshToken": "jwt-refresh-token"
    }
  }
}
```

#### POST /auth/google

Login or register with Google ID token.

**Request Body:**
```json
{
  "idToken": "google-firebase-id-token"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Google login successful",
  "data": {
    "user": { /* user object */ },
    "tokens": {
      "accessToken": "jwt-access-token",
      "refreshToken": "jwt-refresh-token"
    }
  }
}
```

#### POST /auth/refresh

Refresh access token using refresh token.

**Request Body:**
```json
{
  "refreshToken": "jwt-refresh-token"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Token refreshed successfully",
  "data": {
    "user": { /* user object */ },
    "tokens": {
      "accessToken": "new-jwt-access-token",
      "refreshToken": "new-jwt-refresh-token"
    }
  }
}
```

#### GET /auth/me

Get current authenticated user profile.

**Headers:**
```
Authorization: Bearer <access-token>
```

**Response:**
```json
{
  "success": true,
  "message": "User retrieved successfully",
  "data": {
    "user": { /* user object */ }
  }
}
```

#### POST /auth/logout

Logout current user and revoke Firebase tokens.

**Headers:**
```
Authorization: Bearer <access-token>
```

**Response:**
```json
{
  "success": true,
  "message": "Successfully logged out"
}
```

#### POST /auth/password-reset

Send password reset email.

**Request Body:**
```json
{
  "email": "user@example.com"
}
```

**Response:**
```json
{
  "success": true,
  "message": "If the email exists, a password reset link has been sent"
}
```

#### POST /auth/verify-email

Verify email address with Firebase ID token.

**Request Body:**
```json
{
  "idToken": "firebase-email-verification-token"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Email verified successfully"
}
```

## Error Responses

All error responses follow this format:

```json
{
  "success": false,
  "message": "Error message",
  "error": {
    "code": "ERROR_CODE",
    "details": "Detailed error information"
  }
}
```

### Common Error Codes

- `400` - Bad Request (validation errors)
- `401` - Unauthorized (invalid or missing token)
- `403` - Forbidden (account locked, inactive, etc.)
- `404` - Not Found
- `409` - Conflict (email already exists)
- `429` - Too Many Requests (rate limiting)
- `500` - Internal Server Error

## Security Features

### Password Requirements

- Minimum 8 characters
- At least one uppercase letter
- At least one lowercase letter
- At least one number
- At least one special character (@$!%*?&)

### Account Security

- Maximum 5 login attempts before account lock
- Account locked for 30 minutes after max attempts
- Automatic unlock after lockout period
- Login attempts reset on successful login

### Token Management

- Access tokens expire in 7 days (configurable)
- Refresh tokens expire in 30 days (configurable)
- Firebase tokens are revoked on logout
- JWT tokens are signed with secret key

## Rate Limiting

- 100 requests per 15-minute window per IP
- Applies to all `/api/` endpoints
- Returns 429 status when limit exceeded

## CORS Configuration

- Configurable origins (default: all origins)
- Supports credentials
- Allows standard HTTP methods
- Custom headers: Content-Type, Authorization, x-app-token

## User Model

```json
{
  "id": "uuid",
  "email": "string",
  "firstName": "string",
  "lastName": "string",
  "firebaseUid": "string",
  "provider": "email|google",
  "emailVerified": "boolean",
  "profilePicture": "string|null",
  "isActive": "boolean",
  "lastLoginAt": "date|null",
  "createdAt": "date",
  "updatedAt": "date"
}
```

## User Management Endpoints

### Get User Profile

**Endpoint:** `GET /api/v1/users/profile`  
**Access:** Authenticated users (own profile)

**Description:** Get complete user profile combining PostgreSQL and Firebase data.

**Headers:**
```
Authorization: Bearer <access-token>
```

**Response:**
```json
{
  "success": true,
  "message": "User profile retrieved successfully",
  "data": {
    "user": {
      "id": "uuid",
      "firebaseUid": "firebase-uid",
      "systemRole": "user",
      "displayName": "John Doe",
      "isActive": true,
      "lastLoginAt": "2024-01-15T10:30:00Z",
      "createdAt": "2024-01-01T00:00:00Z",
      "updatedAt": "2024-01-15T10:30:00Z",
      "email": "user@example.com",
      "photoURL": "https://...",
      "emailVerified": true,
      "providerData": [...],
      "metadata": {
        "creationTime": "2024-01-01T00:00:00Z",
        "lastSignInTime": "2024-01-15T10:30:00Z"
      }
    }
  }
}
```

### Get Users List (Advanced)

**Endpoint:** `GET /api/v1/users`  
**Access:** System Admin only

**Query Parameters:**
- `page` (optional): Page number (default: 1)
- `limit` (optional): Items per page (default: 20, max: 100)
- `systemRole` (optional): Filter by system role (`super_admin`, `system_admin`, `user`)
- `isActive` (optional): Filter by status (true/false)
- `search` (optional): Search in email, displayName, systemRole, firebaseUid
- `sortBy` (optional): Sort field (`createdAt`, `updatedAt`, `lastLoginAt`, `systemRole`)
- `sortOrder` (optional): Sort order (`ASC`, `DESC`)
- `includeDeleted` (optional): Include soft deleted users (default: false)
- `dateFrom` (optional): Filter users created after this date (ISO format)
- `dateTo` (optional): Filter users created before this date (ISO format)

**Response:**
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

### Get User Organizations

**Endpoint:** `GET /api/v1/users/:firebaseUid/organizations`  
**Access:** Own user or Super Admin

**Description:** Get paginated list of organizations for a specific user with advanced filtering, search, and sorting capabilities.

**Path Parameters:**
- `firebaseUid` (required): Firebase UID of the user

**Query Parameters:**
- `page` (optional): Page number (default: 1)
- `limit` (optional): Items per page (default: 20, max: 100)
- `includeInactive` (optional): Include inactive memberships (default: false)
- `role` (optional): Filter by organization role (`owner`, `admin`, `manager`, `employee`, `viewer`, `guest`)
- `search` (optional): Search in organization name, slug, or description
- `sortBy` (optional): Sort field (`joinedAt`, `name`, `createdAt`, `role`) (default: `joinedAt`)
- `sortOrder` (optional): Sort order (`ASC`, `DESC`) (default: `DESC`)

**Permissions:**
- Users can view their own organizations
- Super admins can view any user's organizations

**Example Request:**
```http
GET /api/v1/users/user-firebase-uid-here/organizations?page=1&limit=10&role=admin&sortBy=name&sortOrder=ASC
Authorization: Bearer <access-token>
```

**Response:**
```json
{
  "success": true,
  "message": "User organizations retrieved successfully",
  "data": {
    "organizations": [
      {
        "id": "uuid",
        "name": "Acme Corporation",
        "slug": "acme-corp",
        "description": "Leading provider of innovative solutions",
        "parentId": null,
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
          "email": "contact@acme-corp.com"
        },
        "isActive": true,
        "planType": "free",
        "foundedAt": "2024-01-01T00:00:00Z",
        "createdAt": "2024-01-01T00:00:00Z",
        "updatedAt": "2024-01-01T00:00:00Z",
        "ParentOrganization": null,
        "membership": {
          "id": "uuid",
          "role": "owner",
          "permissions": {
            "users": { "read": true, "write": true, "delete": true, "invite": true },
            "organizations": { "read": true, "write": true, "delete": true, "settings": true }
          },
          "isActive": true,
          "joinedAt": "2024-01-01T00:00:00Z",
          "lastAccessAt": "2024-01-15T10:30:00Z",
          "department": "Engineering",
          "jobTitle": "CTO",
          "invitedBy": null,
          "invitedAt": null
        }
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 10,
      "total": 5,
      "pages": 1,
      "hasNext": false,
      "hasPrev": false
    },
    "filters": {
      "includeInactive": false,
      "role": "admin",
      "search": null,
      "sortBy": "name",
      "sortOrder": "ASC"
    },
    "user": {
      "id": "uuid",
      "firebaseUid": "user-firebase-uid-here",
      "displayName": "John Doe",
      "systemRole": "user"
    }
  }
}
```

### Get Users Overview

**Endpoint:** `GET /api/v1/users/overview`  
**Access:** System Admin only

**Description:** Get dashboard summary with user statistics and distributions.

**Response:**
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

## Environment Variables

Required environment variables for the authentication system:

```env
# JWT Configuration
JWT_SECRET=your-super-secret-jwt-key-here
JWT_EXPIRES_IN=7d
JWT_REFRESH_EXPIRES_IN=30d

# Firebase Configuration
FIREBASE_PROJECT_ID=your-firebase-project-id
FIREBASE_SERVICE_ACCOUNT_PATH=./path-to-service-account.json

# Auth Configuration
BCRYPT_ROUNDS=12
MAX_LOGIN_ATTEMPTS=5
LOCKOUT_TIME=1800000
```

## Getting Started

1. **Install Dependencies**
   ```bash
   npm install firebase-admin jsonwebtoken bcryptjs
   ```

2. **Set Environment Variables**
   - Copy the environment variables above to your `.env` file
   - Update the values with your actual configuration

3. **Import Postman Collection**
   - Import `docs/postman-collection.json` into Postman
   - Import `docs/postman-environment.json` as environment
   - Update environment variables with your server URL

4. **Test the Endpoints**
   - Start with user registration
   - Use the returned tokens for authenticated requests
   - Test Google sign-in with a valid Firebase ID token

## Firebase Setup

To use Google Sign-In, you need to:

1. **Enable Authentication in Firebase Console**
   - Go to Firebase Console > Authentication > Sign-in method
   - Enable Email/Password and Google providers

2. **Configure Google Sign-In**
   - Add your domain to authorized domains
   - Configure OAuth consent screen in Google Cloud Console

3. **Generate Service Account Key**
   - Go to Firebase Console > Project Settings > Service Accounts
   - Generate new private key and save as JSON file
   - Update `FIREBASE_SERVICE_ACCOUNT_PATH` in environment variables

## Database Schema

The User table will be created automatically with the following structure:

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password VARCHAR(255),
  first_name VARCHAR(255) NOT NULL,
  last_name VARCHAR(255) NOT NULL,
  firebase_uid VARCHAR(255) UNIQUE,
  provider ENUM('email', 'google') DEFAULT 'email',
  email_verified BOOLEAN DEFAULT false,
  profile_picture VARCHAR(255),
  is_active BOOLEAN DEFAULT true,
  last_login_at TIMESTAMP,
  login_attempts INTEGER DEFAULT 0,
  locked_until TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

## Support

For issues or questions about the authentication system, please refer to:
- Firebase Authentication documentation
- JWT.io for token debugging
- Postman collection for API testing examples
