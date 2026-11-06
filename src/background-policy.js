// Process exits can be retried. A live but unhealthy process must be reviewed,
// because killing it can interrupt an unconfirmed external side effect.
export function restartDecision({ probe, healthy = false, attempts = [], now = Date.now(), disabled = false }) {
  const recent = attempts.filter(at => now - at < 15 * 60000);
  if (disabled) return { start: false, state: 'stopped', attempts: recent };
  if (probe !== 'absent') return { start: false, state: healthy ? 'running' : 'review', attempts: recent };
  if (recent.length >= 3) return { start: false, state: 'cooldown', attempts: recent };
  const delay = 15000 * 2 ** Math.max(0, recent.length - 1);
  if (recent.length && now - recent.at(-1) < delay) return { start: false, state: 'backoff', attempts: recent };
  return { start: true, state: 'starting', attempts: [...recent, now] };
}
