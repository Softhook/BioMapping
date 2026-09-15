/**
 * Synthetic pilot of the ui_*.js "augment file" pattern — a small object of
 * methods meant to be Object.assign'd onto a core object elsewhere, in the
 * same shape as ui_export.js/ui_modals.js/etc. `this` inside these methods
 * refers to whatever object they get assigned onto (notice_core.mjs's
 * NoticeCore), not to this module.
 */
export const augmentMethods = {
  showUrgent(msg) {
    this.show(`URGENT: ${msg}`);
  },
};
