# Multi-Tenant Environment Variables - Mordecai API

## 🔧 Complete .env Configuration

```bash
# =============================================================================
# APPLICATION CONFIGURATION
# =============================================================================
APP_NAME=Mordecai API
PORT=3000
NODE_ENV=development
API_VERSION=v1
VALIDATE_ENV=false

# =============================================================================
# DATABASE CONFIGURATION
# =============================================================================
DB_NAME=mordecai_multitenant
DB_USER=postgres
DB_PASSWORD=your_secure_password
DB_HOST=localhost
DB_PORT=5432
DB_LOGGING=false

# Database sync configuration
DB_SYNC_MODE=alter
# Options: 'alter' (modify existing), 'force' (recreate), false (no sync)

# =============================================================================
# MULTI-TENANT FEATURE FLAGS
# =============================================================================
# Enable multi-tenant functionality
ENABLE_MULTI_TENANT=true

# Legacy mode (for backward compatibility)
LEGACY_MODE=false

# Database table sync control (granular)
SYNC_USERS=true
SYNC_ORGANIZATIONS=true
SYNC_ORG_USERS=true

# =============================================================================
# MULTI-TENANT SETTINGS
# =============================================================================
# Default organization slug for single-tenant compatibility
DEFAULT_ORG_SLUG=default

# Maximum organizations per user (0 = unlimited)
MAX_ORGS_PER_USER=10

# Allow users to create organizations
ALLOW_ORG_CREATION=true

# Require invitation to join organizations
REQUIRE_ORG_INVITE=false

# =============================================================================
# FIREBASE CONFIGURATION
# =============================================================================
FIREBASE_PROJECT_ID=your-firebase-project-id

# Option 1: Use environment variables (recommended for production)
FIREBASE_USE_ENV_VARS=true
FIREBASE_TYPE=service_account
FIREBASE_PRIVATE_KEY_ID=your_private_key_id
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYOUR_PRIVATE_KEY_HERE\n-----END PRIVATE KEY-----\n"
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@your-project.iam.gserviceaccount.com
FIREBASE_CLIENT_ID=your_client_id
FIREBASE_AUTH_URI=https://accounts.google.com/o/oauth2/auth
FIREBASE_TOKEN_URI=https://oauth2.googleapis.com/token
FIREBASE_AUTH_PROVIDER_X509_CERT_URL=https://www.googleapis.com/oauth2/v1/certs
FIREBASE_CLIENT_X509_CERT_URL=https://www.googleapis.com/robot/v1/metadata/x509/firebase-adminsdk-xxxxx%40your-project.iam.gserviceaccount.com
FIREBASE_UNIVERSE_DOMAIN=googleapis.com

# Option 2: Use JSON file (for development)
# FIREBASE_USE_ENV_VARS=false
# FIREBASE_SERVICE_ACCOUNT_PATH=./path-to-service-account.json

# =============================================================================
# JWT CONFIGURATION
# =============================================================================
JWT_SECRET=your-super-secret-jwt-key-minimum-32-characters-long
JWT_EXPIRES_IN=7d
JWT_REFRESH_EXPIRES_IN=30d

# =============================================================================
# AUTHENTICATION CONFIGURATION
# =============================================================================
BCRYPT_ROUNDS=12
MAX_LOGIN_ATTEMPTS=5
LOCKOUT_TIME=1800000

# =============================================================================
# CORS CONFIGURATION
# =============================================================================
CORS_ORIGIN=*
CORS_CREDENTIALS=false

# =============================================================================
# RATE LIMITING
# =============================================================================
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX=100

# =============================================================================
# DEVELOPMENT/DEBUGGING
# =============================================================================
# Enable debug logging
DEBUG=mordecai:*

# Log levels: error, warn, info, debug
LOG_LEVEL=info

# Pretty print logs in development
LOG_PRETTY=true
```

## 🚀 Quick Setup Configurations

### Development Setup (Local)
```bash
# Minimal development configuration
ENABLE_MULTI_TENANT=true
DB_SYNC_MODE=alter
SYNC_USERS=true
SYNC_ORGANIZATIONS=true
SYNC_ORG_USERS=true
FIREBASE_USE_ENV_VARS=false
FIREBASE_SERVICE_ACCOUNT_PATH=./firebase-service-account.json
DEBUG=mordecai:*
```

### Production Setup
```bash
# Production configuration
NODE_ENV=production
ENABLE_MULTI_TENANT=true
DB_SYNC_MODE=false  # Use migrations in production
VALIDATE_ENV=true
FIREBASE_USE_ENV_VARS=true
LOG_LEVEL=warn
CORS_ORIGIN=https://yourdomain.com
RATE_LIMIT_MAX=1000
```

### Testing Setup
```bash
# Testing configuration
NODE_ENV=test
ENABLE_MULTI_TENANT=true
DB_NAME=mordecai_test
DB_SYNC_MODE=force  # Recreate tables for clean tests
LOG_LEVEL=error
```

## 🔄 Migration Scenarios

### Scenario 1: Gradual Multi-Tenant Rollout
```bash
# Phase 1: Create tables only
ENABLE_MULTI_TENANT=true
SYNC_ORGANIZATIONS=true
SYNC_ORG_USERS=false

# Phase 2: Enable memberships
SYNC_ORG_USERS=true

# Phase 3: Full activation
ALLOW_ORG_CREATION=true
```

### Scenario 2: Single Organization Mode
```bash
# Multi-tenant infrastructure with single org behavior
ENABLE_MULTI_TENANT=true
MAX_ORGS_PER_USER=1
ALLOW_ORG_CREATION=false
REQUIRE_ORG_INVITE=true
DEFAULT_ORG_SLUG=company
```

### Scenario 3: Enterprise Mode
```bash
# Full multi-tenant with restrictions
ENABLE_MULTI_TENANT=true
MAX_ORGS_PER_USER=5
ALLOW_ORG_CREATION=false  # Admin-only org creation
REQUIRE_ORG_INVITE=true   # Invitation-only
```

## 🛡️ Security Configurations

### High Security
```bash
# Maximum security settings
BCRYPT_ROUNDS=15
MAX_LOGIN_ATTEMPTS=3
LOCKOUT_TIME=3600000  # 1 hour
RATE_LIMIT_MAX=50
CORS_ORIGIN=https://yourdomain.com
CORS_CREDENTIALS=true
REQUIRE_ORG_INVITE=true
```

### Development Security
```bash
# Relaxed for development
BCRYPT_ROUNDS=10
MAX_LOGIN_ATTEMPTS=10
LOCKOUT_TIME=300000  # 5 minutes
RATE_LIMIT_MAX=1000
CORS_ORIGIN=*
```

## 🔍 Debugging Configurations

### Full Debug Mode
```bash
# Maximum debugging
DEBUG=*
LOG_LEVEL=debug
LOG_PRETTY=true
DB_LOGGING=true
```

### Specific Module Debug
```bash
# Debug specific modules
DEBUG=mordecai:tenant,mordecai:org,mordecai:auth
LOG_LEVEL=debug
```

### Performance Debug
```bash
# Monitor performance
DEBUG=mordecai:perf,mordecai:db
LOG_LEVEL=info
```

## 📊 Database Configurations

### Development Database
```bash
DB_NAME=mordecai_dev
DB_SYNC_MODE=alter
SYNC_USERS=true
SYNC_ORGANIZATIONS=true
SYNC_ORG_USERS=true
```

### Production Database
```bash
DB_NAME=mordecai_prod
DB_SYNC_MODE=false  # Use migrations
# Connection pooling
PG_POOL_MAX=20
PG_POOL_MIN=5
PG_POOL_ACQUIRE=60000
PG_POOL_IDLE=10000
```

### Test Database
```bash
DB_NAME=mordecai_test
DB_SYNC_MODE=force  # Clean slate for tests
PG_POOL_MAX=5
```

## 🌐 Multi-Environment Setup

### .env.development
```bash
NODE_ENV=development
ENABLE_MULTI_TENANT=true
DB_SYNC_MODE=alter
DEBUG=mordecai:*
LOG_PRETTY=true
CORS_ORIGIN=http://localhost:3000
```

### .env.staging
```bash
NODE_ENV=staging
ENABLE_MULTI_TENANT=true
DB_SYNC_MODE=false
LOG_LEVEL=info
CORS_ORIGIN=https://staging.yourdomain.com
RATE_LIMIT_MAX=500
```

### .env.production
```bash
NODE_ENV=production
ENABLE_MULTI_TENANT=true
DB_SYNC_MODE=false
VALIDATE_ENV=true
LOG_LEVEL=warn
CORS_ORIGIN=https://yourdomain.com
RATE_LIMIT_MAX=1000
```

## ⚠️ Important Notes

### Security Warnings
- **Never commit real credentials** to version control
- **Use strong JWT secrets** (minimum 32 characters)
- **Enable VALIDATE_ENV=true** in production
- **Use FIREBASE_USE_ENV_VARS=true** in production
- **Set restrictive CORS_ORIGIN** in production

### Performance Tips
- **Set DB_SYNC_MODE=false** in production (use migrations)
- **Adjust pool settings** based on load
- **Use appropriate LOG_LEVEL** (warn/error in production)
- **Enable rate limiting** with appropriate limits

### Multi-Tenant Tips
- **Start with ENABLE_MULTI_TENANT=false** for testing
- **Use gradual rollout** with sync flags
- **Set reasonable MAX_ORGS_PER_USER** limits
- **Consider REQUIRE_ORG_INVITE=true** for security

## 🔧 Environment Validation

The application validates required environment variables on startup:

```javascript
// Required variables (always)
const required = [
  'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DB_HOST',
  'JWT_SECRET', 'FIREBASE_PROJECT_ID'
];

// Additional required when using Firebase env vars
if (FIREBASE_USE_ENV_VARS === 'true') {
  required.push(
    'FIREBASE_PRIVATE_KEY_ID',
    'FIREBASE_PRIVATE_KEY',
    'FIREBASE_CLIENT_EMAIL',
    'FIREBASE_CLIENT_ID'
  );
}
```

Set `VALIDATE_ENV=true` to enforce validation in production.

---

💡 **Tip**: Copy the configuration that matches your use case and customize as needed!
