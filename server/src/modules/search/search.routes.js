import { Router } from 'express';

/** Admin search tools. Paths relative to /api/v1; /admin/* is role-gated structurally in app.js. */
export function createSearchRouter({ adminController }) {
  const router = Router();
  router.post('/admin/search/reindex', adminController.reindex);
  return router;
}