(() => {
'use strict';
class WelcomeMark {
 constructor({ main, root }) {
  root.innerHTML = '<div class="sekai-welcome-mark"><sekai-mark></sekai-mark></div><h1>Sekai Code</h1><p>Build something worth making.</p>';
  const sync = () => { root.classList.toggle('is-shown', main.classList.contains('is-empty')); };
  new MutationObserver(sync).observe(main, { attributes: true, attributeFilter: ['class'] });
  sync();
 }
}
window.WelcomeMark = WelcomeMark;
})();
