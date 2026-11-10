export function createUpdateNotice({ api, visible, hasCapability }) {
  const $ = id => document.getElementById(id);
  let releaseState;
  let updatesBusy = false;
  let updateError = "";
  let copyFeedbackTimer;
  let copyAttempt = 0;
  let closed = false;

  function renderUpdates(updates = releaseState) {
    if (closed) return;
    $("check-updates").disabled = !hasCapability;
    $("check-updates").setAttribute("aria-busy", String(updatesBusy || Boolean(updates?.checking)));
    if (!updates) {
      const message = updateError || (updatesBusy ? "Checking..." : "");
      $("update-status").textContent = message ? ` - ${message}` : "";
      $("update-status").hidden = !message;
      return;
    }
    if (releaseState?.currentVersion !== updates.currentVersion ||
        releaseState?.latestVersion !== updates.latestVersion ||
        releaseState?.status !== updates.status || releaseState?.prompt !== updates.prompt) {
      copyAttempt++;
      resetCopyFeedback();
    }
    releaseState = updates;
    $("installed-version").textContent = `Notifications Canvas v${updates.currentVersion}`;
    const messages = {
      unchecked: "",
      no_release: "No stable release yet.",
      current: "Up to date",
      ahead: "Newer than the latest release.",
      available: `Update available: v${updates.latestVersion}.`,
    };
    const retry = updates.error && Date.now() < updates.canCheckAt
      ? ` Retry after ${new Date(updates.canCheckAt).toLocaleTimeString()}.` : "";
    const message = updateError || (updatesBusy || updates.checking ? "Checking..." :
      updates.error ? `${updates.error}${retry}` : messages[updates.status]);
    $("update-status").textContent = message ? ` - ${message}` : "";
    $("update-status").hidden = !message;
    const available = updates.status === "available";
    $("update-banner").hidden = !available;
    if (!available) {
      setUpdateDetails(false);
      return;
    }
    $("update-title").textContent = `Update available \u00b7 v${updates.latestVersion}`;
    $("update-current-version").textContent = `Currently v${updates.currentVersion}`;
    $("update-stale").hidden = !updates.error;
    $("update-stale").textContent = updates.error ? "Last known release; the latest check failed." : "";
    $("release-notes").href = updates.releaseUrl;
    $("update-instructions").href = updates.instructionsUrl;
    if ($("update-prompt").value !== updates.prompt) {
      $("update-prompt").value = updates.prompt;
    }
  }

  function setUpdateDetails(open) {
    const details = $("update-prompt-details");
    const toggle = $("update-details-toggle");
    if (!open && document.hasFocus() && details.contains(document.activeElement)) toggle.focus();
    details.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
  }

  function resetCopyFeedback() {
    clearTimeout(copyFeedbackTimer);
    $("copy-update").textContent = "Copy update prompt";
    $("copy-status").textContent = "";
  }

  async function checkUpdates() {
    if (closed || !visible() || updatesBusy) return;
    updatesBusy = true;
    updateError = "";
    renderUpdates();
    try {
      renderUpdates(await api("updates", {}));
    } catch (error) {
      updateError = error.message || "Could not check for updates. Try again.";
    } finally {
      updatesBusy = false;
      renderUpdates();
    }
  }

  async function copyUpdatePrompt() {
    if (closed || !visible() || releaseState?.status !== "available" || !releaseState.prompt) return;
    const attempt = ++copyAttempt;
    const prompt = releaseState.prompt;
    resetCopyFeedback();
    try {
      await navigator.clipboard.writeText(prompt);
      if (attempt !== copyAttempt || !visible() || releaseState?.status !== "available" || releaseState.prompt !== prompt) return;
      resetCopyFeedback();
      $("copy-update").textContent = "Copied";
      $("copy-status").textContent = "Paste into Copilot to review and run.";
      copyFeedbackTimer = setTimeout(() => {
        $("copy-update").textContent = "Copy update prompt";
      }, 4000);
    } catch {
      if (attempt !== copyAttempt || !visible() || releaseState?.status !== "available" || releaseState.prompt !== prompt) return;
      resetCopyFeedback();
      setUpdateDetails(true);
      if (document.hasFocus()) {
        $("update-prompt").focus();
        $("update-prompt").select();
      }
      $("copy-status").textContent = "Clipboard unavailable. Copy the selected prompt and paste it into Copilot.";
    }
  }

  const toggleDetails = () => setUpdateDetails($("update-prompt-details").hidden);
  const listeners = [
    [$("check-updates"), checkUpdates],
    [$("copy-update"), copyUpdatePrompt],
    [$("update-details-toggle"), toggleDetails],
  ];
  for (const [control, handler] of listeners) control.addEventListener("click", handler);

  return {
    render: renderUpdates,
    invalidateCopy() { copyAttempt++; },
    close() {
      if (closed) return;
      closed = true;
      copyAttempt++;
      clearTimeout(copyFeedbackTimer);
      for (const [control, handler] of listeners) control.removeEventListener("click", handler);
    },
  };
}
