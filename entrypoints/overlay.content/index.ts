import './style.css';
import { MessageType } from '@/utils/messages';

export default defineContentScript({
  matches: ['<all_urls>'],
  cssInjectionMode: 'ui',

  async main(ctx) {
    console.log('[content] overlay content script loaded');

    const ui = await createShadowRootUi(ctx, {
      name: 'bloom-overlay',
      position: 'overlay',
      anchor: 'body',
      isolateEvents: true,
      onMount(container) {
        const wrapper = document.createElement('div');
        wrapper.id = 'bloom-root';

        const controls = document.createElement('div');
        controls.className = 'bloom-controls';
        controls.style.display = 'none';

        const timer = document.createElement('span');
        timer.className = 'bloom-timer';
        timer.textContent = '00:00';

        const stopBtn = document.createElement('button');
        stopBtn.className = 'bloom-btn bloom-btn-stop';
        stopBtn.textContent = 'Stop';
        stopBtn.addEventListener('click', () => {
          browser.runtime.sendMessage({ type: MessageType.STOP_RECORDING });
        });

        controls.append(timer, stopBtn);
        wrapper.append(controls);
        container.append(wrapper);
        return wrapper;
      },
      onRemove(wrapper) {
        wrapper?.remove();
      },
    });

    ui.mount();

    // Listen for state changes to show/hide controls
    browser.runtime.onMessage.addListener((message) => {
      if (message.type === MessageType.STATE_CHANGED) {
        const controls = ui.shadow.querySelector('.bloom-controls') as HTMLElement;
        if (controls) {
          controls.style.display = message.state === 'recording' ? 'flex' : 'none';
        }
      }
    });
  },
});
