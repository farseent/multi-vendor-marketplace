import { AuditLog } from './audit.model.js';

export function createAuditService() {
  return {
    /**
     * actor is req.user ({ id, role }). Call after the change succeeded, or pass the caller's
     * transaction `session` to commit the entry together with the change (D49).
     */
    record(actor, { action, entityType, entityId, meta }, { session } = {}) {
      return AuditLog.create(
        [
          {
            actorId: actor.id,
            actorRole: actor.role,
            action,
            entityType,
            entityId,
            meta,
          },
        ],
        { session },
      ).then(([entry]) => entry);
    },
  };
}
