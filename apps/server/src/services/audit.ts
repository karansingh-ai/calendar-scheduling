import type { Db } from "../db";
import { auditLog } from "../db/schema";

export interface AuditActor {
  userId: string | null;
  label: string; // email, "invitee:<email>", "system", "api-key:<prefix>"
  ip?: string | null;
}

export async function audit(
  db: Db,
  actor: AuditActor,
  action: string,
  target?: { type: string; id: string },
  metadata: Record<string, unknown> = {},
) {
  await db.insert(auditLog).values({
    actorUserId: actor.userId,
    actorLabel: actor.label,
    action,
    targetType: target?.type,
    targetId: target?.id,
    metadata,
    ip: actor.ip ?? null,
  });
}
