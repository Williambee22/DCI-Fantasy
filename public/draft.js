(() => {
  const app = document.getElementById('draft-app');
  if (!app) return;

  const leagueId = app.dataset.leagueId;
  const csrf = app.dataset.csrf;
  const form = document.getElementById('pick-form');
  const corpsSelect = document.getElementById('corps-select');
  const captionSelect = document.getElementById('caption-select');
  const componentSelect = document.getElementById('component-select');
  const draftButton = document.getElementById('draft-button');
  const errorBox = document.getElementById('pick-error');
  let state = null;
  let submitting = false;

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function componentLabel(pick) {
    return pick.component === 'FIRST' ? pick.first_label : pick.second_label;
  }

  function updateComponentLabels() {
    const option = captionSelect.selectedOptions[0];
    if (!option) return;
    componentSelect.options[0].textContent = option.dataset.first || 'Content';
    componentSelect.options[1].textContent = option.dataset.second || 'Achievement';
    updateButtonState();
  }

  function chosenKey() {
    return `${corpsSelect.value}:${captionSelect.value}:${componentSelect.value}`;
  }

  function draftedKeys() {
    return new Set((state?.picks || []).map((pick) => `${pick.corps_id}:${pick.caption_code}:${pick.component}`));
  }

  function updateButtonState() {
    if (!state) {
      draftButton.disabled = true;
      return;
    }
    const isTurn = state.onClockUserId === state.currentUserId;
    const available = !draftedKeys().has(chosenKey());
    draftButton.disabled = submitting || state.league.status !== 'ACTIVE' || !isTurn || !available;
    if (!available) errorBox.textContent = 'That exact asset has already been drafted.';
    else if (!submitting) errorBox.textContent = '';
  }

  function render() {
    const league = state.league;
    document.getElementById('draft-status').textContent = league.status;
    document.getElementById('draft-round').textContent = league.round || '—';
    document.getElementById('draft-pick').textContent = `${Math.min(league.currentPick, league.totalPicks)}/${league.totalPicks}`;
    document.getElementById('pick-progress').textContent = `${state.picks.length} of ${league.totalPicks} picks complete`;

    const onClockMember = state.members.find((member) => member.user_id === state.onClockUserId);
    const onClock = document.getElementById('on-clock');
    const turnMessage = document.getElementById('turn-message');
    if (league.status === 'COMPLETE') {
      onClock.textContent = 'Draft complete';
      turnMessage.textContent = 'All fantasy assets have been selected.';
    } else if (league.status === 'PAUSED') {
      onClock.textContent = 'Draft paused';
      turnMessage.textContent = 'The commissioner must resume the draft.';
    } else if (league.status === 'SETUP') {
      onClock.textContent = 'Waiting to start';
      turnMessage.textContent = 'The commissioner must randomize the order and start the draft.';
    } else if (onClockMember) {
      onClock.textContent = `${onClockMember.team_name} (@${onClockMember.username})`;
      turnMessage.textContent = onClockMember.user_id === state.currentUserId ? 'You are on the clock.' : 'Waiting for this manager to make a pick.';
    }

    const order = document.getElementById('draft-order');
    order.innerHTML = state.members.map((member) => `
      <li class="${member.user_id === state.onClockUserId ? 'on-clock' : ''}">
        <div><strong>${escapeHtml(member.team_name)}</strong><small>@${escapeHtml(member.username)}</small></div>
      </li>
    `).join('');

    const history = document.getElementById('pick-history');
    if (!state.picks.length) {
      history.innerHTML = '<tr><td colspan="5" class="muted">No picks yet.</td></tr>';
    } else {
      history.innerHTML = [...state.picks].reverse().map((pick) => `
        <tr>
          <td>#${pick.pick_number}</td>
          <td><strong>${escapeHtml(pick.team_name)}</strong></td>
          <td>${escapeHtml(pick.corps_name)}</td>
          <td>${escapeHtml(pick.caption_name)}</td>
          <td>${escapeHtml(componentLabel(pick))}</td>
        </tr>
      `).join('');
    }
    updateButtonState();
  }

  async function refresh() {
    try {
      const response = await fetch(`/api/leagues/${leagueId}/draft-state`, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error('Could not load draft state.');
      state = await response.json();
      render();
    } catch (error) {
      errorBox.textContent = error.message;
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (draftButton.disabled) return;
    submitting = true;
    updateButtonState();
    errorBox.textContent = '';
    try {
      const response = await fetch(`/api/leagues/${leagueId}/picks`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrf,
          accept: 'application/json'
        },
        body: JSON.stringify({
          corps_id: corpsSelect.value,
          caption_code: captionSelect.value,
          component: componentSelect.value
        })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Pick failed.');
      await refresh();
    } catch (error) {
      errorBox.textContent = error.message;
    } finally {
      submitting = false;
      updateButtonState();
    }
  });

  captionSelect.addEventListener('change', updateComponentLabels);
  corpsSelect.addEventListener('change', updateButtonState);
  componentSelect.addEventListener('change', updateButtonState);
  updateComponentLabels();
  refresh();
  window.setInterval(refresh, 2500);
})();
