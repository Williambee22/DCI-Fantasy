(() => {
  const app = document.getElementById('draft-app');

  if (!app) {
    return;
  }

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
  let requestError = '';

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function componentLabel(pick) {
    return pick.component === 'FIRST'
      ? pick.first_label
      : pick.second_label;
  }

  function updateComponentLabels() {
    const option = captionSelect.selectedOptions[0];

    if (!option) {
      return;
    }

    componentSelect.options[0].textContent =
      option.dataset.first || 'Content';

    componentSelect.options[1].textContent =
      option.dataset.second || 'Achievement';

    requestError = '';
    updateButtonState();
  }

  /**
   * Identifies the exact fantasy asset selected:
   *
   * corps + caption + Content/Achievement
   *
   * Example:
   * Bluecoats + Brass + Content
   */
  function chosenKey() {
    return [
      corpsSelect.value,
      captionSelect.value,
      componentSelect.value
    ].join(':');
  }

  /**
   * Identifies the manager's required roster slot:
   *
   * caption + Content/Achievement
   *
   * Example:
   * Brass + Content
   */
  function teamSlotKey() {
    return [
      captionSelect.value,
      componentSelect.value
    ].join(':');
  }

  /**
   * Returns every exact asset already drafted
   * anywhere in the league.
   */
  function draftedKeys() {
    return new Set(
      (state?.picks || []).map((pick) => (
        [
          pick.corps_id,
          pick.caption_code,
          pick.component
        ].join(':')
      ))
    );
  }

  /**
   * Returns every caption/component slot already
   * filled by the signed-in manager.
   */
  function filledTeamSlots() {
    return new Set(
      (state?.picks || [])
        .filter(
          (pick) =>
            String(pick.user_id)
            === String(state?.currentUserId)
        )
        .map((pick) => (
          [
            pick.caption_code,
            pick.component
          ].join(':')
        ))
    );
  }

  function updateButtonState() {
    if (!state) {
      draftButton.disabled = true;
      return;
    }

    const isDraftActive =
      state.league.status === 'ACTIVE';

    const isTurn =
      String(state.onClockUserId)
      === String(state.currentUserId);

    const exactAssetAvailable =
      !draftedKeys().has(chosenKey());

    const teamSlotAvailable =
      !filledTeamSlots().has(teamSlotKey());

    draftButton.disabled =
      submitting
      || !isDraftActive
      || !isTurn
      || !exactAssetAvailable
      || !teamSlotAvailable;

    if (!teamSlotAvailable) {
      const selectedComponent =
        componentSelect.options[
          componentSelect.selectedIndex
        ]?.textContent || 'subcaption';

      errorBox.textContent =
        `Your team already filled ${selectedComponent} for this caption. Choose the other subcaption or another caption.`;

      return;
    }

    if (!exactAssetAvailable) {
      errorBox.textContent =
        'That exact corps, caption, and subcaption combination has already been drafted by another team.';

      return;
    }

    if (requestError) {
      errorBox.textContent = requestError;
      return;
    }

    if (!submitting) {
      errorBox.textContent = '';
    }
  }

  function render() {
    const league = state.league;

    document.getElementById(
      'draft-status'
    ).textContent = league.status;

    document.getElementById(
      'draft-round'
    ).textContent = league.round || '—';

    const displayedPick =
      league.totalPicks > 0
        ? Math.min(
            league.currentPick,
            league.totalPicks
          )
        : 0;

    document.getElementById(
      'draft-pick'
    ).textContent =
      `${displayedPick}/${league.totalPicks}`;

    document.getElementById(
      'pick-progress'
    ).textContent =
      `${state.picks.length} of ${league.totalPicks} picks complete`;

    const onClockMember = state.members.find(
      (member) =>
        String(member.user_id)
        === String(state.onClockUserId)
    );

    const onClock =
      document.getElementById('on-clock');

    const turnMessage =
      document.getElementById('turn-message');

    if (league.status === 'COMPLETE') {
      onClock.textContent = 'Draft complete';

      turnMessage.textContent =
        'Every manager has one Content and one Achievement selection from every caption.';
    } else if (league.status === 'PAUSED') {
      onClock.textContent = 'Draft paused';

      turnMessage.textContent =
        'The commissioner must resume the draft.';
    } else if (league.status === 'SETUP') {
      onClock.textContent = 'Waiting to start';

      turnMessage.textContent =
        'The commissioner must set or randomize the draft order and start the draft.';
    } else if (onClockMember) {
      onClock.textContent =
        `${onClockMember.team_name} (@${onClockMember.username})`;

      const currentUserIsOnClock =
        String(onClockMember.user_id)
        === String(state.currentUserId);

      turnMessage.textContent =
        currentUserIsOnClock
          ? 'You are on the clock.'
          : 'Waiting for this manager to make a pick.';
    } else {
      onClock.textContent = 'Waiting';

      turnMessage.textContent =
        'Waiting for the next draft turn.';
    }

    const order =
      document.getElementById('draft-order');

    order.innerHTML = state.members
      .map((member) => {
        const isOnClock =
          String(member.user_id)
          === String(state.onClockUserId);

        const memberPickCount = state.picks.filter(
          (pick) =>
            String(pick.user_id)
            === String(member.user_id)
        ).length;

        return `
          <li class="${isOnClock ? 'on-clock' : ''}">
            <div>
              <strong>
                ${escapeHtml(member.team_name)}
              </strong>

              <small>
                @${escapeHtml(member.username)}
                ·
                ${memberPickCount}/${league.rosterSize} picks
              </small>
            </div>
          </li>
        `;
      })
      .join('');

    const history =
      document.getElementById('pick-history');

    if (!state.picks.length) {
      history.innerHTML = `
        <tr>
          <td colspan="5" class="muted">
            No picks yet.
          </td>
        </tr>
      `;
    } else {
      history.innerHTML = [...state.picks]
        .reverse()
        .map((pick) => `
          <tr>
            <td>
              #${pick.pick_number}
            </td>

            <td>
              <strong>
                ${escapeHtml(pick.team_name)}
              </strong>
            </td>

            <td>
              ${escapeHtml(pick.corps_name)}
            </td>

            <td>
              ${escapeHtml(pick.caption_name)}
            </td>

            <td>
              ${escapeHtml(componentLabel(pick))}
            </td>
          </tr>
        `)
        .join('');
    }

    updateButtonState();
  }

  async function refresh() {
    try {
      const response = await fetch(
        `/api/leagues/${leagueId}/draft-state`,
        {
          headers: {
            accept: 'application/json'
          }
        }
      );

      if (!response.ok) {
        throw new Error(
          'Could not load draft state.'
        );
      }

      state = await response.json();

      /*
       * Clear an old request error once fresh state
       * has successfully loaded.
       */
      requestError = '';

      render();
    } catch (error) {
      errorBox.textContent = error.message;
    }
  }

  form.addEventListener(
    'submit',
    async (event) => {
      event.preventDefault();

      if (draftButton.disabled) {
        return;
      }

      submitting = true;
      requestError = '';

      updateButtonState();

      try {
        const response = await fetch(
          `/api/leagues/${leagueId}/picks`,
          {
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
          }
        );

        let payload = {};

        try {
          payload = await response.json();
        } catch (_error) {
          payload = {};
        }

        if (!response.ok) {
          throw new Error(
            payload.error || 'Pick failed.'
          );
        }

        await refresh();
      } catch (error) {
        requestError = error.message;
      } finally {
        submitting = false;
        updateButtonState();
      }
    }
  );

  captionSelect.addEventListener(
    'change',
    updateComponentLabels
  );

  corpsSelect.addEventListener(
    'change',
    () => {
      requestError = '';
      updateButtonState();
    }
  );

  componentSelect.addEventListener(
    'change',
    () => {
      requestError = '';
      updateButtonState();
    }
  );

  updateComponentLabels();
  refresh();

  window.setInterval(
    refresh,
    2500
  );
})();
