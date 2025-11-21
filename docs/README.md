# Mordecai API

A complete authentication system built with Node.js, Express, Firebase, and PostgreSQL for the Mordecai application.

## Features

- ✅ Email/Password registration and login
- ✅ Google Sign-In integration
- ✅ JWT token management (access + refresh tokens)
- ✅ Password reset functionality
- ✅ Email verification
- ✅ Account security (login attempts, account locking)
- ✅ Rate limiting
- ✅ Comprehensive error handling
- ✅ Postman collection for testing
- ✅ Complete API documentation

## Quick Start

### 1. Environment Setup

Create a `.env` file in the project root. See [Environment Variables Guide](./ENV_VARIABLES.md) for complete configuration details.

**Quick setup - copy this to your `.env` file:**

```env
# Mordecai API Configuration
APP_NAME=Mordecai API
PORT=3000
NODE_ENV=development
API_VERSION=v1

# PostgreSQL Database
DB_NAME=mordecai_db
DB_USER=mordecai_user
DB_PASSWORD=your_secure_password_here
DB_HOST=localhost
DB_PORT=5432
DB_SYNC_MODE=alter

# JWT (IMPORTANT: Change in production!)
JWT_SECRET=your-super-secret-jwt-key-here-change-this-in-production-mordecai-2024
JWT_EXPIRES_IN=7d
JWT_REFRESH_EXPIRES_IN=30d

# Firebase (choose one option)
# Option 1: JSON file (simpler)
FIREBASE_USE_ENV_VARS=false
FIREBASE_PROJECT_ID=testing-multi-provider
FIREBASE_SERVICE_ACCOUNT_PATH=./testing-multi-provider-firebase-adminsdk-fbsvc-88c3e328ca.json

# Option 2: Environment variables (more secure)
# FIREBASE_USE_ENV_VARS=true
# FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYOUR_KEY_HERE\n-----END PRIVATE KEY-----\n"
# FIREBASE_CLIENT_EMAIL=your-service-account@project.iam.gserviceaccount.com
# ... (see Firebase setup guide for all variables)

# Security
BCRYPT_ROUNDS=12
MAX_LOGIN_ATTEMPTS=5
LOCKOUT_TIME=1800000
CORS_ORIGIN=*
RATE_LIMIT_MAX=100
```

📋 **[Complete .env Template →](./COMPLETE_ENV_TEMPLATE.md)** | **[Environment Variables Guide →](./ENV_VARIABLES.md)**

### 2. PostgreSQL Database Setup

Make sure PostgreSQL is running and create a database. See [PostgreSQL Setup Guide](./POSTGRESQL_SETUP.md) for detailed instructions.

**Quick setup:**
```sql
-- Connect to PostgreSQL
sudo -u postgres psql

-- Create database and user
CREATE DATABASE mordecai_db;
CREATE USER mordecai_user WITH PASSWORD 'your_secure_password';
GRANT ALL PRIVILEGES ON DATABASE mordecai_db TO mordecai_user;
```

The User table will be created automatically when you start the server.

### 3. Firebase Setup

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Create a new project or use existing one
3. Enable Authentication > Sign-in method > Email/Password and Google
4. Go to Project Settings > Service Accounts
5. Generate new private key and save as JSON file
6. Update `FIREBASE_SERVICE_ACCOUNT_PATH` in your `.env` file

### 4. Start the Server

```bash
npm run dev
```

The server will start on `http://localhost:3000`

### 5. Test with Postman

1. Import `docs/postman-collection.json` into Postman
2. Import `docs/postman-environment.json` as environment
3. Start testing the endpoints!

## API Endpoints

### Public Endpoints
- `POST /api/v1/auth/register` - Register with email/password
- `POST /api/v1/auth/login` - Login with email/password
- `POST /api/v1/auth/google` - Login/Register with Google
- `POST /api/v1/auth/refresh` - Refresh access token
- `POST /api/v1/auth/password-reset` - Send password reset email
- `POST /api/v1/auth/verify-email` - Verify email address

### Protected Endpoints
- `GET /api/v1/auth/me` - Get current user profile
- `POST /api/v1/auth/logout` - Logout user

## Project Structure

```
src/
├── config/
│   ├── database.js          # Database configuration
│   ├── firebase.js          # Firebase configuration
│   └── index.js             # Main configuration
├── controllers/
│   └── auth.controller.js   # Authentication controller
├── middlewares/
│   └── auth.middleware.js   # Authentication middleware
├── models/
│   ├── user.model.js        # User model
│   └── index.js             # Models index
├── routes/
│   ├── auth.route.js        # Authentication routes
│   └── index.js             # Routes index
├── services/
│   └── auth.service.js      # Authentication service
├── validators/
│   └── auth.validator.js    # Request validators
└── server.js                # Server setup
```

## Security Features

- **Password Requirements**: 8+ chars, uppercase, lowercase, number, special char
- **Account Locking**: 5 failed attempts = 30min lockout
- **JWT Tokens**: Secure access and refresh token system
- **Rate Limiting**: 100 requests per 15 minutes per IP
- **Firebase Integration**: Secure token verification
- **Input Validation**: Comprehensive request validation

## Documentation

- [Complete API Documentation](./API_DOCUMENTATION.md)
- [Users List API Guide](./USERS_LIST_API.md) 👥 **NEW**
- [Users List Examples](./USERS_LIST_EXAMPLES.md) 💡 **NEW**
- [Display Name Implementation](./DISPLAY_NAME_IMPLEMENTATION.md) 📝 **NEW**
- [Multi-Tenant Architecture Guide](./MULTI_TENANT_GUIDE.md) 🏢 **NEW**
- [Multi-Tenant Environment Setup](./MULTI_TENANT_ENV_EXAMPLE.md) ⚙️ **NEW**
- [Postman Multi-Tenant Guide](./POSTMAN_MULTI_TENANT_GUIDE.md) 📮 **NEW**
- [Complete .env Template](./COMPLETE_ENV_TEMPLATE.md) ⭐
- [Environment Variables Guide](./ENV_VARIABLES.md)
- [Firebase Environment Setup](./FIREBASE_ENV_SETUP.md)
- [PostgreSQL Setup Guide](./POSTGRESQL_SETUP.md)
- [User Model Optimization](./USER_MODEL_OPTIMIZATION.md) 🚀
- [Optimized API Changes](./OPTIMIZED_API_CHANGES.md) 📊
- [Roles Architecture](./ROLES_ARCHITECTURE.md) 👥
- [Preferences Options](./PREFERENCES_OPTIONS.md) ⚙️
- [Soft Delete Guide](./SOFT_DELETE_GUIDE.md) 🛡️
- [Branding Update](./BRANDING_UPDATE.md) 🎯
- [Security Notes](./SECURITY_NOTES.md) 🔒
- [Postman Collection](./postman-collection.json)
- [Postman Environment](./postman-environment.json)

## Testing

Use the provided Postman collection to test all endpoints. The collection includes:

1. **User Registration** - Create new account
2. **Email Login** - Login with credentials
3. **Google Login** - Login with Google ID token
4. **Token Refresh** - Refresh expired tokens
5. **Get Profile** - Get current user data
6. **Logout** - Revoke tokens
7. **Password Reset** - Send reset email
8. **Email Verification** - Verify email address

## Production Deployment

Before deploying to production:

1. **Change JWT Secret**: Generate a strong, unique JWT secret
2. **Update CORS**: Set specific allowed origins
3. **Database**: Use production database credentials
4. **Firebase**: Use production Firebase project
5. **Environment**: Set `NODE_ENV=production`
6. **SSL**: Enable HTTPS
7. **Rate Limiting**: Adjust limits based on your needs

## Troubleshooting

### Common Issues

1. **Firebase Errors**: Check service account key path and permissions
2. **Database Errors**: Verify PostgreSQL is running and credentials are correct
3. **JWT Errors**: Ensure JWT_SECRET is set and consistent
4. **CORS Errors**: Update CORS_ORIGIN in environment variables

### Logs

The application uses structured logging. Check console output for detailed error information.

## Support

For issues or questions:
1. Check the API documentation
2. Review Postman collection examples
3. Check application logs
4. Verify environment variables

## License

This project is licensed under the ISC License.
