(() => {
'use strict';
class SekaiMark extends HTMLElement {
 constructor() {
  super();
  this.attachShadow({ mode: 'open' }).innerHTML = `<style>:host{display:block;color:#39c9ad}svg{width:100%;height:100%;display:block}</style><svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="square" aria-hidden="true"><path d="m21 15-15 17 15 17M43 15l15 17-15 17M37 8 27 56"/></svg>`;
 }
 connectedCallback() { this.setAttribute('role', 'img'); this.setAttribute('aria-label', 'Sekai Code'); }
 look() {}
 blink() {}
}
customElements.define('sekai-mark', SekaiMark);
})();
