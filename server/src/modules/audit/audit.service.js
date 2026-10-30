import { AuditLog } from './audit.model.js';

export function createAuditService() {
  return {
    /** actor is req.user ({ id, role }). Call after the change succeeded. */
    record(actor, { action, entityType, entityId, meta }) {
      return AuditLog.create({
        actorId: actor.id,
        actorRole: actor.role,
        action,
        entityType,
        entityId,
        meta,
      });
    },
  };
}
