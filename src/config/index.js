import dotenv from 'dotenv';

dotenv.config();

const requiredEnvVars = [
  'DB_NAME',
  'DB_USER',
  'DB_PASSWORD',
  'DB_HOST',
  'JWT_SECRET',
  'FIREBASE_PROJECT_ID',
];

// Additional required vars when using Firebase environment variables
const firebaseEnvVars = [
  'FIREBASE_PRIVATE_KEY_ID',
  'FIREBASE_PRIVATE_KEY',
  'FIREBASE_CLIENT_EMAIL',
  'FIREBASE_CLIENT_ID',
  'FIREBASE_CLIENT_X509_CERT_URL',
];

const validateEnvVars = () => {
  const missing = requiredEnvVars.filter((key) => !process.env[key]);
  
  // If using Firebase environment variables, validate those too
  if (process.env.FIREBASE_USE_ENV_VARS === 'true') {
    const missingFirebase = firebaseEnvVars.filter((key) => !process.env[key]);
    missing.push(...missingFirebase);
  } else if (!process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    missing.push('FIREBASE_SERVICE_ACCOUNT_PATH');
  }
  
  if (missing.length > 0) {
    throw new Error(
      `Environment variables missing: ${missing.join(', ')}`
    );
  }
};

// Validar solo en producción o si se especifica
if (process.env.NODE_ENV === 'production' || process.env.VALIDATE_ENV === 'true') {
  validateEnvVars();
}

export const config = {
  app: {
    name: process.env.APP_NAME || 'Mordecai API',
    port: Number(process.env.PORT) || 3000,
    nodeEnv: process.env.NODE_ENV || 'development',
    apiVersion: process.env.API_VERSION || 'v1',
  },
  db: {
    name: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 5432,
    dialect: 'postgres',
    pool: {
      acquire: Number(process.env.PG_POOL_ACQUIRE) || 60000,
      idle: Number(process.env.PG_POOL_IDLE) || 10000,
      max: Number(process.env.PG_POOL_MAX) || 10,
      min: Number(process.env.PG_POOL_MIN) || 0,
    },
    logging: process.env.DB_LOGGING === 'true',
    sync: {
      // Opciones: 'alter', 'force', false
      // 'alter': modifica tablas existentes
      // 'force': elimina y recrea tablas (¡CUIDADO en producción!)
      // false: no sincroniza (usa migraciones)
      mode: process.env.DB_SYNC_MODE || false,
    },
  },
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    credentials: process.env.CORS_CREDENTIALS === 'true',
  },
  rateLimit: {
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutos
    max: Number(process.env.RATE_LIMIT_MAX) || 100, // 100 requests por ventana
  },
  
  firebase: {
    // Use environment variables if available, otherwise fallback to JSON file
    useEnvVars: process.env.FIREBASE_USE_ENV_VARS === 'true',
    
    // Environment variables configuration
    type: process.env.FIREBASE_TYPE || 'service_account',
    projectId: process.env.FIREBASE_PROJECT_ID || 'testing-multi-provider',
    privateKeyId: process.env.FIREBASE_PRIVATE_KEY_ID,
    privateKey: process.env.FIREBASE_PRIVATE_KEY,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    clientId: process.env.FIREBASE_CLIENT_ID,
    authUri: process.env.FIREBASE_AUTH_URI || 'https://accounts.google.com/o/oauth2/auth',
    tokenUri: process.env.FIREBASE_TOKEN_URI || 'https://oauth2.googleapis.com/token',
    authProviderX509CertUrl: process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL || 'https://www.googleapis.com/oauth2/v1/certs',
    clientX509CertUrl: process.env.FIREBASE_CLIENT_X509_CERT_URL,
    universeDomain: process.env.FIREBASE_UNIVERSE_DOMAIN || 'googleapis.com',
    
    // Fallback to JSON file
    serviceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './testing-multi-provider-firebase-adminsdk-fbsvc-88c3e328ca.json',
  },
  
  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  },
  
  auth: {
    bcryptRounds: Number(process.env.BCRYPT_ROUNDS) || 12,
    maxLoginAttempts: Number(process.env.MAX_LOGIN_ATTEMPTS) || 5,
    lockoutTime: Number(process.env.LOCKOUT_TIME) || 30 * 60 * 1000, // 30 minutes
  },
  
  // Multi-tenant configuration
  features: {
    multiTenant: process.env.ENABLE_MULTI_TENANT === 'true',
  },
  
  // Database sync configuration (granular control)
  dbSync: {
    users: process.env.SYNC_USERS !== 'false',           // Default: true
    organizations: process.env.SYNC_ORGANIZATIONS === 'true',  // Default: false
    organizationUsers: process.env.SYNC_ORG_USERS === 'true'   // Default: false
  },
  
  // Multi-tenant settings
  tenant: {
    defaultOrgSlug: process.env.DEFAULT_ORG_SLUG || 'default',
    maxOrgsPerUser: Number(process.env.MAX_ORGS_PER_USER) || 10,
    allowOrgCreation: process.env.ALLOW_ORG_CREATION !== 'false',
    requireOrgInvite: process.env.REQUIRE_ORG_INVITE === 'true',
  },
};

