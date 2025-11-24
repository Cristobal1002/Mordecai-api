# Mordecai-api

Backend de consumo para integración Siigo y comercios electrónicos.

## 🚀 Inicio Rápido

### Prerrequisitos

- Node.js >= 18.0.0
- npm >= 9.0.0
- PostgreSQL

### Instalación

1. Clonar el repositorio
```bash
git clone <repository-url>
cd node-boilerplate
```

2. Instalar dependencias
```bash
npm install
```

3. Configurar variables de entorno
```bash
cp .env.example .env
# Editar .env con tus configuraciones
```

4. Iniciar servidor de desarrollo
```bash
npm run dev
```

5. Iniciar servidor de producción
```bash
npm start
```

## 📁 Estructura del Proyecto

```
├── src/
│   ├── config/          # Configuraciones (DB, Firebase, etc.)
│   ├── controllers/      # Controladores
│   ├── errors/          # Clases de errores personalizados
│   ├── loaders/         # Cargadores (Express, DB, etc.)
│   ├── middlewares/     # Middlewares personalizados
│   ├── models/          # Modelos de Sequelize
│   ├── routes/          # Definición de rutas
│   ├── services/        # Lógica de negocio
│   ├── utils/           # Utilidades (logger, helpers)
│   └── server.js        # Configuración del servidor
├── app.js               # Punto de entrada
└── package.json
```

## 🛠️ Scripts Disponibles

- `npm start` - Inicia el servidor en producción
- `npm run dev` - Inicia el servidor en modo desarrollo con nodemon
- `npm test` - Ejecuta los tests con coverage
- `npm run test:watch` - Ejecuta tests en modo watch
- `npm run lint` - Verifica el código con ESLint
- `npm run lint:fix` - Corrige errores de ESLint automáticamente
- `npm run format` - Formatea el código con Prettier

## 🔧 Configuración

### Variables de Entorno

Ver `.env.example` para todas las variables disponibles.

### Base de Datos

El proyecto usa Sequelize como ORM. Configura las variables de entorno de base de datos en `.env`.

## 📝 API

### Health Checks

- `GET /api/v1/health` - Health check básico
- `GET /api/v1/health/ready` - Readiness probe (verifica DB)
- `GET /api/v1/health/live` - Liveness probe

## 🧪 Testing

```bash
npm test
```

## 📦 Dependencias Principales

- **Express** - Framework web
- **Sequelize** - ORM para PostgreSQL
- **Pino** - Logger estructurado
- **Helmet** - Seguridad HTTP
- **express-rate-limit** - Rate limiting
- **express-validator** - Validación de requests

## 🔒 Seguridad

- Helmet para headers de seguridad
- Rate limiting configurado
- Validación de inputs con express-validator
- Manejo seguro de errores (sin exponer stack traces en producción)

## 📄 Licencia

ISC

