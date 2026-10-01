'use strict';
const { ipcRenderer } = require('electron');
// Electron has no window.prompt(); ask the main process to show a small dialog instead.
window.prompt = function (message, def) {
  return ipcRenderer.sendSync('presenter:prompt', message == null ? '' : String(message), def == null ? '' : String(def));
};
// Lets the page tell the desktop shell how the Live window should be created
// (a transparent window has to be made transparent when it is opened).
window.presenterDesktop = {
  setBgMode: function (mode) { ipcRenderer.send('presenter:bgmode', String(mode), true); }
};
window.addEventListener('DOMContentLoaded', function () {
  try { ipcRenderer.send('presenter:bgmode', localStorage.getItem('presenter_bgmode_v1') || 'dark', false); } catch (e) {}
});
