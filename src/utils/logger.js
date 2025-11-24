import pino from 'pino';

const isDevelopment = process.env.NODE_ENV === 'development';

// Función helper para obtener información de la llamada
const getCallerInfo = () => {
  const originalFunc = Error.prepareStackTrace;
  let callerfile;
  let callersite;
  
  try {
    const err = new Error();
    let currentfile;
    
    Error.prepareStackTrace = (err, stack) => stack;
    currentfile = err.stack.shift().getFileName();
    
    // Buscar el primer archivo que no sea logger.js
    while (err.stack.length) {
      callersite = err.stack.shift();
      callerfile = callersite.getFileName();
      if (callerfile !== currentfile) break;
    }
  } catch (err) {
    // Fallback si no se puede obtener
    return {};
  } finally {
    Error.prepareStackTrace = originalFunc;
  }
  
  // Convertir a ruta relativa desde la raíz del proyecto
  let relativePath = callerfile;
  const projectRoot = process.cwd();
  
  if (callerfile && callerfile.startsWith(projectRoot)) {
    relativePath = callerfile.replace(projectRoot, '');
    // Remover el separador inicial si existe (Windows: \ o /, Unix: /)
    relativePath = relativePath.replace(/^[\/\\]/, '');
    // Normalizar separadores para usar siempre /
    relativePath = relativePath.replace(/\\/g, '/');
  }
  
  return {
    //file: relativePath || callerfile,
    //line: callersite ? callersite.getLineNumber() : undefined,
    //column: callersite ? callersite.getColumnNumber() : undefined,,
     line: `${callerfile}:${callersite.getLineNumber()}}`
  };
};

const logger = pino({
  level: process.env.LOG_LEVEL || (isDevelopment ? 'debug' : 'info'),
  transport: isDevelopment
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss Z',
          ignore: 'pid,hostname',
          // Incluir ubicación si está disponible
          includeLocation: true,
        },
      }
    : undefined,
  formatters: {
    level: (label) => {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Agregar información de ubicación a los logs
  mixin() {
    return getCallerInfo();
  },
});

export { logger };