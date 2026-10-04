(() => {
'use strict';

const root = document.documentElement;
if (window.sekai?.desktop) root.classList.add('is-desktop');
if (window.sekai?.platform === 'darwin') root.classList.add('is-mac');
if (window.sekai?.platform === 'linux') root.classList.add('is-linux');
})();
