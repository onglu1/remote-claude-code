/** Runtime registries must be keyed by project + conversation, not convId alone. */
export function conversationRuntimeKey(projectId: string, convId: string): string {
  return `${projectId}:${convId}`;
}
