import { Router } from 'express';
import { createHealthController } from './health.controller.js';

export function createHealthRouter(service) {
  const controller = createHealthController(service);
  const router = Router();
  router.get('/', controller.live);
  router.get('/ready', controller.ready);
  return router;
}
