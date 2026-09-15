/**
 * Synthetic pilot of the ui.js "core file composes its augments" pattern:
 * explicitly imports each augment module and Object.assigns it onto the
 * shared object, replacing today's load-order + dual-mode-tail bridge.
 * References `document` bare (no import) — real DOM globals stay ambient,
 * resolved via boot_pilot.mjs's jsdom-global bridge, exactly like a real
 * browser <script type="module"> would resolve it from `window`.
 */
import { augmentMethods } from './notice_augment.mjs';

export const NoticeCore = {
  show(msg) {
    document.getElementById('notice').textContent = msg;
  },
};

Object.assign(NoticeCore, augmentMethods);
