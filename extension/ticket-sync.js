// Popup-only read model. Each lane selection starts a new generation so a slow
// reply from the previous harness cannot paint over the current ticket.
export function createTicketSync(request, onState) {
  let lane = '';
  let generation = 0;
  let pending = false;

  async function refresh() {
    if (!lane || pending) return;
    const requestLane = lane;
    const requestGeneration = generation;
    pending = true;
    try {
      const response = await request(requestLane);
      if (generation !== requestGeneration) return;
      if (!response?.ok || !response.snapshot || !('ticket' in response.snapshot)) {
        onState({ kind: 'error', error: response?.error || 'Ticket unavailable' });
        return;
      }
      onState({ kind: 'ready', ticket: response.snapshot.ticket });
    } catch (error) {
      if (generation === requestGeneration) {
        onState({ kind: 'error', error: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (generation === requestGeneration) pending = false;
    }
  }

  function selectLane(nextLane) {
    lane = nextLane || '';
    generation += 1;
    pending = false;
    onState({ kind: lane ? 'loading' : 'no-lane' });
    return refresh();
  }

  return { selectLane, refresh };
}

export function githubIssueUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' &&
      /^\/[^/]+\/[^/]+\/issues\/\d+\/?$/.test(url.pathname) &&
      !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export function formatTicketBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}
