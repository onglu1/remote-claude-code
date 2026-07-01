import type { AuthUser, Conversation, Project } from '@rcc/shared';
import type { AppContext } from '../context';
import { canSeeProject } from '../lib/authz';
import { conversationRuntimeKey } from '../lib/conversationIdentity';

type StoredConversation = Omit<Conversation, 'alive'>;

export interface SessionScope {
  project: Project;
  conversation: StoredConversation;
  runtimeKey: string;
}

export function resolveVisibleProject(
  ctx: AppContext,
  user: AuthUser,
  projectId: string,
): Project | null {
  const project = ctx.projects.get(projectId);
  if (!project || !canSeeProject(user, project)) return null;
  return project;
}

export function resolveSessionScope(
  ctx: AppContext,
  user: AuthUser,
  projectId: string,
  convId: string,
  opts: { includeDeleted?: boolean } = {},
): SessionScope | null {
  const project = resolveVisibleProject(ctx, user, projectId);
  if (!project) return null;
  const conversation = ctx.conversations.getInProject(projectId, convId);
  if (!conversation) return null;
  if (!opts.includeDeleted && conversation.deletedAt) return null;
  return {
    project,
    conversation,
    runtimeKey: conversationRuntimeKey(projectId, convId),
  };
}
