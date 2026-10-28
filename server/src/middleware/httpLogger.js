import { pinoHttp } from 'pino-http';

export function httpLogger(logger) {
  return pinoHttp({
    logger,
    genReqId: (req) => req.id,
    // Probes hit /health constantly; logging them only adds noise.
    autoLogging: { ignore: (req) => req.url.includes('/health') },
    customLogLevel: (_req, res, err) =>
      err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
  });
}
