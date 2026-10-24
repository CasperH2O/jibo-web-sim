// Chat tab — the simulator's stand-in for talking to Jibo.
//
// Typing a line simulates speech recognition: the text is logged as a user
// message and handed to the send handler (wired to AsrService.recognize in
// main.js), which delivers it to the skill as recognized speech. Jibo's TTS
// responses are logged back via addJiboMessage().
//
// Every message also goes to the optional onMessage(who, text) hook so the host
// can mirror the conversation somewhere outside the DOM (see main.js).

export function installChatPanel(panelEl, { onMessage } = {}) {
  panelEl.innerHTML = '';
  panelEl.classList.add('chat-panel');

  const log = document.createElement('div');
  log.className = 'chat-log';

  const form = document.createElement('form');
  form.className = 'chat-input';
  form.innerHTML = `
    <input type="text" placeholder="Say something to Jibo…" autocomplete="off" />
    <button type="submit">Send</button>
    <button type="button" class="chat-mic" title="Talk to Jibo (server-side ASR)">\u{1F3A4}</button>
  `;
  const input = form.querySelector('input');
  const micBtn = form.querySelector('.chat-mic');

  panelEl.append(log, form);

  let sendHandler = null;
  let voiceHandler = null;
  let enabled = false;
  input.disabled = true;
  micBtn.disabled = true;

  micBtn.addEventListener('click', () => {
    if (!voiceHandler) return;
    micBtn.disabled = true;
    micBtn.textContent = '\u23FA';      // recording indicator
    Promise.resolve(voiceHandler()).finally(() => {
      micBtn.textContent = '\u{1F3A4}';
      micBtn.disabled = !voiceHandler;
    });
  });

  function addMessage(who, text) {
    const row = document.createElement('div');
    row.className = `chat-msg chat-${who}`;
    row.textContent = text;
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
    if (onMessage) {
      try { onMessage(who, text); } catch (_) { /* mirroring must never break the chat */ }
    }
  }

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = input.value.trim();
    if (!text || !enabled || !sendHandler) return;
    addMessage('user', text);
    input.value = '';
    sendHandler(text);
  });

  return {
    setSendHandler(fn) {
      sendHandler = fn;
      enabled = true;
      input.disabled = false;
    },
    setVoiceHandler(fn) {
      voiceHandler = fn;
      micBtn.disabled = !fn;
    },
    // Programmatically start a voice turn (e.g. from wake-word detection),
    // reusing the mic button's exact path — same recording UI, same handler.
    // No-op (returns false) if the button is disabled, i.e. a turn is already
    // in flight, so a "Hey Jibo" mid-turn can't stack a second capture.
    triggerVoice() {
      if (micBtn.disabled || !voiceHandler) return false;
      micBtn.click();
      return true;
    },
    setPlaceholder: (text) => { if (text) input.placeholder = text; },
    addUserMessage: (text) => addMessage('user', text),
    addJiboMessage: (text) => addMessage('jibo', text),
    addSystemMessage: (text) => addMessage('system', text),
  };
}
