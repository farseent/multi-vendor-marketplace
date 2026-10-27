import { AppError } from '../../lib/AppError.js';

export function createHealthController(service) {
  return {
    live(_req, res) {
      res.json({ success: true, data: service.liveness() });
    },

    async ready(_req, res) {
      const { ready, status, components } = await service.readiness();
      if (!ready) {
        throw new AppError('SERVICE_UNAVAILABLE', 503, 'A required dependency is unavailable', {
          status,
          components,
        });
      }
      res.json({ success: true, data: { status, components } });
    },
  };
}