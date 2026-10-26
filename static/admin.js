(() => {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  function activate() {
    const hash = location.hash.slice(1);
    const selected = ['race', 'race-setup'].includes(hash) ? 'setup' : ['setup', 'monitoring', 'register', 'share'].includes(hash) ? hash : 'setup';
    tabs.forEach(tab => {
      const active = tab.dataset.tab === selected;
      tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
      document.getElementById(tab.getAttribute('aria-controls')).hidden = !active;
      if (active) tab.scrollIntoView({block: 'nearest', inline: 'nearest'});
    });
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => { location.hash = tab.dataset.tab; });
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].focus(); tabs[next].click();
    });
  });
  addEventListener('hashchange', activate); activate();
})();
